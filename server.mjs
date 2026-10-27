import {choiceProblem,safeFallback} from './lib/decision.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World, WorldError, hash } from './lib/world.mjs';
import { Models, modelFailureReason } from './lib/models.mjs';
import { Recovery, smtpMailer } from './lib/recovery.mjs';
import { decisionProblem } from './lib/perception.mjs';
import { Ollama } from './lib/ollama.mjs';

const root=dirname(fileURLToPath(import.meta.url));
// Load local configuration without dependencies; never expose it through static routes.
if(existsSync(resolve(root,'.env'))) process.loadEnvFile(resolve(root,'.env'));
export function createApp({database=':memory:',autoRun=false,allowLocalModels=process.env.ALLOW_LOCAL_MODEL_URLS==='1',mailer=smtpMailer(),appUrl=process.env.APP_URL,ollamaBase}={}) {
  const world=new World(database);world.setMeta('running',autoRun?'1':'0');
  const ollama=new Ollama(world,ollamaBase?{base:ollamaBase}:{});
  const models=new Models(world,{keyPath:database===':memory:'?undefined:resolve(dirname(database),'model-encryption.key'),allowLocal:allowLocalModels,ollama});
  world.validateResidentMode=(resident,localModel)=>{
    if(typeof localModel!=='string')throw new WorldError('本地模型选择格式无效');
    if(localModel){ollama.sharedConfiguration(localModel);return;}
    if(!resident.user_id||!models.public(resident.user_id).configured)throw new WorldError(`${resident.name}尚未配置可用模型，请选择管理员共享的本地模型`);
    models.get(resident.user_id);
  };
  const recovery=new Recovery(world,models,{mailer,appUrl});
  let advancing=false;
  const pendingDecisions=new Map(),streams=new Set();
  const closeStreams=()=>{for(const response of streams)response.end();streams.clear();};
  let lastPushed=-1;
  const streamTimer=setInterval(()=>{if(world.revision===lastPushed)return;lastPushed=world.revision;const payload=`data: ${JSON.stringify({revision:world.revision,tick:world.tick})}\n\n`;for(const response of streams)if(!response.destroyed)response.write(payload);},500);streamTimer.unref();
  const heartbeat=setInterval(()=>{for(const response of streams)if(!response.destroyed)response.write(': heartbeat\n\n');},15000);heartbeat.unref();
  let localHealth=null,healthProbe=null;
  async function serviceHealth(){if(localHealth&&Date.now()-localHealth.checkedAt<30000)return localHealth;if(healthProbe)return healthProbe;healthProbe=(async()=>{try{const r=await ollama.request('/api/version',undefined,{timeoutMs:2500});localHealth={reachable:true,checkedAt:Date.now(),version:typeof r.version==='string'?r.version.slice(0,40):null};}catch{localHealth={reachable:false,checkedAt:Date.now(),version:null};}finally{healthProbe=null;}return localHealth;})();return healthProbe;}
  const rate=new Map();
  const limit=(key,max,ms)=>{const now=Date.now(),entry=rate.get(key);if(!entry||entry.until<now){rate.set(key,{count:1,until:now+ms});return;}if(++entry.count>max)throw new WorldError('请求过于频繁，请稍后再试',429);};
  async function advance() {
    if(advancing) throw new WorldError('世界正在推进，请稍后',409);
    advancing=true;
    try {
      world.advance();
      residentsLoop: for(const r of world.db.prepare("SELECT * FROM residents WHERE mode='llm'").all()) {
        if(world.resident(r.id).mode!=='llm'||world.navigation.reserved(r.id))continue;
        const control=world.control(r.id);if(control.suspended||control.removed)continue;
        let config;const began=Date.now(),trace={outcome:'discarded',action:null,attempts:0,reason:'推理期间运行模式、配置或控制状态发生变化'};
        const controlsCurrent=()=>world.resident(r.id).mode==='llm'&&!world.navigation.reserved(r.id)&&!world.control(r.id).suspended&&!world.control(r.id).removed&&world.control(r.id).revision===control.revision;
        const current=()=>controlsCurrent()&&config&&models.currentForResident(r,config);
        try {
          config=models.forResident(r);if(!config){trace.outcome='failed';trace.reason='尚未配置可用模型';continue;}
          pendingDecisions.set(r.id,{id:r.id,startedAt:Date.now()});world.touch();
          let lastError='',choice,executed=false;
          for(let attempt=0;attempt<2;attempt++){
            const observation=world.observe(r.id);if(lastError)observation.decisionGuide.lastError=lastError;
            const {systemPrompt,...context}=observation;
            trace.attempts++;choice=await models.complete(config,[{role:'system',content:systemPrompt},{role:'user',content:JSON.stringify(context)}]);
            if(!current())continue residentsLoop;
            const latest=world.revision===observation.revision?observation:world.observe(r.id);
            const problem=choiceProblem(choice,latest)||decisionProblem(world,r.id,choice);
            if(problem){lastError=problem;continue;}
            try{world.action(r.id,choice.action,choice.parameters||{},`llm:${world.tick}`);executed=true;trace.outcome='executed';trace.action=choice.action;trace.reason='';break;}
            catch(error){if(!(error instanceof WorldError))throw error;lastError=error.message;}
          }
          if(!executed)throw new WorldError(`决策需调整：${lastError}`);
          if(choice.communication&&typeof choice.communication==='object'&&!Array.isArray(choice.communication)){
            try{world.communicate(r.id,choice.communication,`llm:${world.tick}:communication`);}
            catch(error){world.memory(r.id,`本次附带交流未执行：${error instanceof WorldError?error.message:modelFailureReason(error)}`);}
          }
        } catch(e) {
          if(!controlsCurrent()||config&&!models.currentForResident(r,config))continue;
          const reason=e instanceof WorldError?e.message:modelFailureReason(e);trace.outcome='failed';trace.reason=reason;
          let recovered=false;
          if(config){const step=safeFallback(world,r.id);if(step&&!decisionProblem(world,r.id,step)){try{world.action(r.id,step.action,step.parameters,`fallback:${world.tick}`);recovered=true;trace.outcome='fallback';trace.action=step.action;world.memory(r.id,`模型失败后采用生存保障行动：${step.action}；原因：${reason}`);world.event('system',r.id,`${r.name}采用生存保障行动`,`模型未完成决策（${reason}）；仅执行当前有效的${step.action}，不代表模型执行成功`);}catch(error){if(!(error instanceof WorldError))throw error;}}}
          if(!recovered){world.memory(r.id,`本次行动未执行：${reason}`);world.event('system',r.id,`${r.name}的模型行动未完成`,reason);}
        }finally{
          world.operations.recordDecision(r.id,{...trace,model:config?.model,latencyMs:Date.now()-began});
          if(pendingDecisions.delete(r.id))world.touch();
        }
      }
    } finally {world.operations.sample();advancing=false;}
    return {ok:true,tick:world.tick};
  }
  const timer=setInterval(()=>{if(world.getMeta('running')==='1'&&!advancing)advance().catch(e=>console.error('World advance:',e.message));},30000);
  timer.unref();
  const housekeeper=setInterval(()=>{const now=Date.now();for(const [k,v] of rate)if(v.until<now)rate.delete(k);world.db.prepare('DELETE FROM sessions WHERE expires<?').run(now);},60000);housekeeper.unref();
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const send=(data,status=200,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data));};
    try {
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      if(path.startsWith('/api/')) {
        limit(`all:${req.socket.remoteAddress}`,300,60000);
        if(path==='/api/stream'&&req.method==='GET'){
          if(streams.size>=100)throw new WorldError('实时连接数已满，请稍后重试',503);
          res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
          res.write(`data: ${JSON.stringify({revision:world.revision,tick:world.tick})}\n\n`);streams.add(res);res.on('close',()=>streams.delete(res));return;
        }
        if(req.method!=='GET') {
          const origin=req.headers.origin;
          if(origin&&origin!==`http://${req.headers.host}`&&origin!==`https://${req.headers.host}`)throw new WorldError('跨站请求被拒绝',403);
          if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new WorldError('请使用 application/json',415);
        }
        const cookie=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('morrow_session='))?.slice(15);
        const user=world.authenticate(cookie);
        const bearer=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
        const agent=world.tokenResident(bearer);
        let body={};
        if(req.method!=='GET') {
          const chunks=[];let size=0;
          for await(const chunk of req){size+=chunk.length;if(size>16384)throw new WorldError('请求内容过大',413);chunks.push(chunk);}
          try{body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw new WorldError('JSON 格式错误');}
          if(!body||typeof body!=='object'||Array.isArray(body))throw new WorldError('请求体必须是 JSON 对象');
        }
        const requireUser=()=>{if(!user)throw new WorldError('请先登录',401);return user;};
        const requireResident=()=>{
          if(agent){const r=world.resident(agent);if(req.method!=='GET'&&r.mode!=='external')throw new WorldError('居民未处于外部代理模式，代理不能执行行动',403);return r;}
          const r=world.residentFor(requireUser().id);if(!r)throw new WorldError('请先申请加入小镇',403);return r;
        };
        const requireOwner=()=>{requireUser();world.requireAdmin(user.id);};
        if(path==='/api/admin/ollama'&&req.method==='GET'){requireOwner();return send(ollama.public(true));}
        if(path==='/api/admin/ollama'&&req.method==='POST'){requireOwner();ollama.configure(user.id,body);try{await ollama.scan();}catch{/* Saved settings remain visible with a truthful connection error. */}return send(ollama.public(true));}
        if(path==='/api/admin/ollama/refresh'&&req.method==='POST'){requireOwner();limit('ollama-scan',6,60000);try{await ollama.scan();}catch{/* Return offline state rather than a fabricated list. */}return send(ollama.public(true));}
        if(path==='/api/ollama/models'&&req.method==='GET'){requireUser();return send(ollama.public(false));}
        if(path==='/api/model/source'&&req.method==='POST'){
          const u=requireUser();if(body.provider==='ollama')ollama.select(u.id,body);else if(body.provider==='api'){if(!models.public(u.id).apiConfigured)throw new WorldError('请先保存你自己的 API 模型配置');ollama.useApi(u.id);}else throw new WorldError('未知模型来源');return send(models.public(u.id));
        }
        if(path==='/api/admin/residents'&&req.method==='GET'){requireOwner();return send({...world.adminResidents(user.id),localModels:ollama.public(false)});}
        if(path==='/api/admin/residents/mode'&&req.method==='POST'){requireOwner();limit(`admin-bulk:${user.id}`,6,60000);return send(world.adminSetAllModes(user.id,body));}
        const managed=path.match(/^\/api\/admin\/residents\/([^/]+)$/);
        if(managed&&req.method==='POST'){requireOwner();limit(`admin:${user.id}`,30,60000);return send(world.adminManage(user.id,decodeURIComponent(managed[1]),body));}
        const ownModel=user?models.public(user.id):{configured:false};
        if(path==='/api/world'&&req.method==='GET')return send({...world.snapshot(user?.id),revision:world.revision,serverNow:Date.now(),thinkingResidents:[...pendingDecisions.values()],user:user||null,canControl:Boolean(user&&world.getMeta('owner')===user.id),modelSettings:ownModel,ollama:user?ollama.public(false):null,accountSecurity:user?recovery.state(user.id):null,capabilities:{mail:recovery.configured,llm:ownModel.configured,model:ownModel.selectedModel||null,interval:30},advancing});
        if(path==='/api/operations'&&req.method==='GET')return send(world.operations.public({viewerId:world.residentFor(user?.id||'')?.id,admin:Boolean(user&&world.getMeta('owner')===user.id),service:await serviceHealth()}));
        if(path==='/api/landscape/chunks'&&req.method==='GET')return send(world.landscape.chunks(url.searchParams.get('x')||0,url.searchParams.get('z')||0,url.searchParams.get('radius')||1));
        if(path==='/api/landscape/site'&&req.method==='GET'){const site=world.findPlace(url.searchParams.get('id'));if(!site)throw new WorldError('场所不存在',404);return send(site);}
        if(path==='/api/perception'&&req.method==='GET'){const r=requireResident();return send(world.observe(r.id));}
        if(path==='/api/mind'&&req.method==='GET'){const r=requireResident();world.requireActive(r.id);const query=url.searchParams.get('q')||r.goal;if(query.length>200)throw new WorldError('检索内容最多200字');return send({...world.mind.state(r.id),results:world.mind.retrieve(r.id,query)});}
        if(path==='/api/messages'&&req.method==='GET'){const r=requireResident();return send({messages:world.inbox(r.id)});}
        if(path==='/api/account/email'&&req.method==='GET')return send(recovery.state(requireUser().id));
        if(path==='/api/account/email'&&req.method==='POST'){const u=requireUser();limit(`bind:${u.id}`,5,60000);return send(recovery.bind(u.id,body));}
        if(path==='/api/account/email/verify'&&req.method==='POST'){limit(`verify:${req.socket.remoteAddress}`,10,60000);return send(recovery.verify(body));}
        if(path==='/api/password/forgot'&&req.method==='POST'){limit(`forgot:${req.socket.remoteAddress}`,5,60000);return send(recovery.forgot(body));}
        if(path==='/api/password/reset'&&req.method==='POST'){limit(`reset:${req.socket.remoteAddress}`,10,60000);const result=recovery.reset(body);return send(result,200,{'Set-Cookie':'morrow_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
        if(path==='/api/model'&&req.method==='GET')return send(models.public(requireUser().id));
        if(path==='/api/model'&&req.method==='POST')return send(models.save(requireUser().id,body));
        if(path==='/api/model/delete'&&req.method==='POST')return send(models.delete(requireUser().id));
        if(path==='/api/model/test'&&req.method==='POST'){
          const u=requireUser();limit(`model-test:${u.id}`,4,60000);const config=models.get(u.id);if(!config)throw new WorldError('请先保存你的模型配置');
          try{await models.complete(config,[{role:'system',content:'Return a JSON object: {"ok":true}.'},{role:'user',content:'Connection test. No resident data is included.'}]);return send({ok:true,message:'连接成功，模型已返回有效 JSON'});}catch(e){throw new WorldError(`连接失败：${modelFailureReason(e)}`,502);}
        }
        if(path==='/api/health'&&req.method==='GET')return send({ok:true,tick:world.tick});
        if(['/api/register','/api/login'].includes(path)&&req.method==='POST') {
          limit(`auth:${req.socket.remoteAddress}`,15,60000);
          const result=path.endsWith('register')?world.register(body.username,body.password):world.login(body.username,body.password);
          return send({user:result.user},200,{'Set-Cookie':`morrow_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`});
        }
        if(path==='/api/logout'&&req.method==='POST'){world.logout(cookie);return send({ok:true},200,{'Set-Cookie':'morrow_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
        if(path==='/api/join'&&req.method==='POST')return send(world.join(requireUser().id,body),201);
        if(path==='/api/actions'&&req.method==='POST') {
          const r=requireResident();limit(`action:${r.id}`,40,60000);
          if(body.parameters===undefined)body.parameters={};
          const result=world.action(r.id,body.action,body.parameters,body.idempotency_key);
          if(body.communication&&typeof body.communication==='object'&&!Array.isArray(body.communication)){
            try{return send({...result,communication:world.communicate(r.id,body.communication,`communication:${hash(body.idempotency_key)}`)});}
            catch(error){return send({...result,communication:{ok:false,error:error instanceof WorldError?error.message:'交流暂未完成'}});}
          }
          return send(result);
        }
        if(path==='/api/proposals'&&req.method==='POST')return send(world.propose(requireResident().id,body),201);
        if(path==='/api/vote'&&req.method==='POST')return send(world.vote(requireResident().id,String(body.proposal_id),body.choice));
        if(path==='/api/advance'&&req.method==='POST'){requireOwner();limit('advance',6,60000);return send(await advance());}
        if(path==='/api/running'&&req.method==='POST') {
          requireOwner();if(typeof body.running!=='boolean')throw new WorldError('running 必须为布尔值');
          world.setMeta('running',body.running?'1':'0');world.touch();return send({ok:true,running:body.running});
        }
        if(path==='/api/mode'&&req.method==='POST') {
          const r=requireResident();if(!['rules','manual','llm','external'].includes(body.mode))throw new WorldError('未知运行模式');
          world.requireActive(r.id);
          if(body.mode==='llm'&&!models.public(r.user_id).configured)throw new WorldError('请先在接入与设置中保存你自己的模型配置');
          if(body.mode==='llm'&&r.mode!=='llm'&&world.db.prepare("SELECT count(*) n FROM residents WHERE mode='llm'").get().n>=8)throw new WorldError('本地版本最多同时运行 8 位账号模型居民；可使用外部代理接入',409);
          world.db.prepare('DELETE FROM resident_model_assignments WHERE resident_id=?').run(r.id);
          world.db.prepare('UPDATE residents SET mode=? WHERE id=?').run(body.mode,r.id);world.touch();return send({ok:true});
        }
        if(path==='/api/agent/token'&&req.method==='POST') {requireUser();const r=world.residentFor(user.id);if(!r)throw new WorldError('请先申请居民身份');return send({token:world.issueToken(r.id)});}
        if(path==='/api/agent/observe'&&req.method==='GET') {
          if(!agent)throw new WorldError('代理令牌无效',401);
          world.requireActive(agent);return send(world.observe(agent));
        }
        const match=path.match(/^\/api\/residents\/([^/]+)$/);
        if(match&&req.method==='GET') {const id=decodeURIComponent(match[1]);return send(world.detail(id,world.residentFor(user?.id||'')?.id===id||agent===id));}
        throw new WorldError('接口不存在',404);
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new WorldError('不支持此方法',405);
      const routes={'/':'index.html','/app.js':'app.js','/terrain.js':'terrain.js','/world-view.js':'world-view.js','/operations.js':'operations.js','/care.js':'care.js','/behavior.js':'behavior.js','/scene-render.js':'scene-render.js','/map-camera.js':'map-camera.js','/society.js':'society.js','/digital.js':'digital.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};
      const file=routes[path];if(!file)throw new WorldError('页面不存在',404);
      const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
      const data=await readFile(resolve(root,'public',file));res.writeHead(200,{'Content-Type':types[extname(file)],'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:data);
    } catch(e) {if(!res.headersSent)send({error:e instanceof WorldError?e.message:'服务暂时不可用'},e.status||500);if(!(e instanceof WorldError))console.error(e);}
  });
  server.on('close',()=>{clearInterval(timer);clearInterval(housekeeper);clearInterval(streamTimer);clearInterval(heartbeat);closeStreams();recovery.close();});
  return {server,world,models,ollama,recovery,advance,closeStreams};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const dataDir=resolve(process.env.DATA_DIR||resolve(root,'data'));
  const app=createApp({database:resolve(dataDir,'world.sqlite'),autoRun:process.env.AUTO_RUN==='1'});
  const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
  app.server.listen(port,host,()=>console.log(`\n  MORROW · 晨曦镇\n  Local: http://${host}:${port}\n  Storage: ${dataDir}\n  Intelligence: 每账号独立模型配置\n`));
  const stop=()=>{app.closeStreams();app.server.close(()=>{app.world.close();process.exit(0);});};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
