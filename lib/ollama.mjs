import {decisionSchema} from './decision.mjs';
import { randomUUID } from 'node:crypto';
import { WorldError, clean } from './world.mjs';
import { summaryMessages, LOCAL_CONTEXT_SIZE } from './context.mjs';

export function ollamaBase(value='http://127.0.0.1:11434'){
  value=String(value).trim();if(value.startsWith(':'))value=`127.0.0.1${value}`;
  if(!/^https?:\/\//.test(value))value=`http://${value}`;
  let url;try{url=new URL(value);}catch{throw new WorldError('请输入有效的 Ollama 本机地址');}
  if(url.hostname==='0.0.0.0'||url.hostname==='localhost')url.hostname='127.0.0.1';
  if(url.hostname==='[::]')url.hostname='[::1]';
  if(!['127.0.0.1','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw new WorldError('Ollama 地址仅允许本机回环地址，不允许远程主机、路径或凭据');
  return url.origin;
}
export class Ollama {
  constructor(world,{base=process.env.OLLAMA_BASE_URL||process.env.OLLAMA_HOST||'http://127.0.0.1:11434'}={}){
    this.world=world;this.busy=false;this.scanning=null;this.templateCompatibility=new Map();
    let initial;try{initial=ollamaBase(base);}catch{initial='http://127.0.0.1:11434';}
    if(!world.getMeta('ollama_base'))world.setMeta('ollama_base',initial);
    if(!world.getMeta('ollama_revision'))world.setMeta('ollama_revision',randomUUID());
    world.db.exec("CREATE TABLE IF NOT EXISTS model_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id),provider TEXT NOT NULL CHECK(provider IN ('api','ollama')),local_model TEXT NOT NULL DEFAULT '',timeout_ms INTEGER NOT NULL DEFAULT 180000,revision TEXT NOT NULL)");
  }
  get enabled(){return this.world.getMeta('ollama_enabled')==='1';}
  get base(){return ollamaBase(this.world.getMeta('ollama_base'));}
  preference(userId){return this.world.db.prepare('SELECT * FROM model_preferences WHERE user_id=?').get(userId);}
  catalog(){try{return JSON.parse(this.world.getMeta('ollama_catalog')||'{"models":[],"available":false,"updatedAt":null}');}catch{return {models:[],available:false,updatedAt:null};}}
  public(admin=false){const cache=this.catalog();return {...cache,enabled:this.enabled,busy:this.busy,models:admin||this.enabled?cache.models:[],...(admin?{base:this.base}:{}),error:cache.error||null};}
  configure(userId,{base,enabled}){
    this.world.requireAdmin(userId);if(typeof enabled!=='boolean')throw new WorldError('请明确是否开放本地模型');
    const next=ollamaBase(clean(base,300));
    this.world.transaction(()=>{if(next!==this.base)this.world.setMeta('ollama_catalog',JSON.stringify({models:[],available:false,updatedAt:null}));this.world.setMeta('ollama_base',next);this.world.setMeta('ollama_enabled',enabled?'1':'0');this.world.setMeta('ollama_revision',randomUUID());this.world.event('admin',null,'管理员更新了 Ollama 本地模型服务',enabled?'已向居民开放本地模型选择':'已关闭本地模型共享');});return this.public(true);
  }
  async request(path,body,{timeoutMs=5000,base=this.base}={}){
    base=ollamaBase(base);
    try{
      const response=await fetch(`${base}${path}`,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw new WorldError('Ollama 响应过大',502);chunks.push(Buffer.from(value));}}finally{await reader.cancel();}
      let result;try{result=JSON.parse(Buffer.concat(chunks).toString());}catch{if(response.ok)throw new WorldError('Ollama 返回了无效的 JSON 响应',502);result={};}
      if(!response.ok){
        // Extract only numeric diagnostics. Never expose arbitrary upstream text
        // (which can contain prompt fragments) in the shared world timeline.
        const exceeded=typeof result.error==='string'&&result.error.match(/request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i);
        if(response.status===400&&exceeded){const error=new WorldError(`居民提示词需要 ${exceeded[1]} tokens，超过本地模型当前上下文窗口 ${exceeded[2]} tokens`,502);error.contextTokens=Number(exceeded[1]);throw error;}
        throw new WorldError(response.status===404?'本机没有该模型，请管理员刷新已安装模型列表':`Ollama 接口返回 HTTP ${response.status}，请检查本机服务与模型兼容性`,502);
      }
      if(result.error)throw new WorldError('Ollama 无法运行该模型，请检查模型状态、内存和服务日志',502);
      return result;
    }catch(error){if(error instanceof WorldError)throw error;if(error.name==='TimeoutError'||error.name==='AbortError')throw new WorldError(`本地模型请求超过 ${Math.ceil(timeoutMs/1000)} 秒，请增加本地模型等待时间或选择较小模型`,504);throw new WorldError('无法连接本机 Ollama，请确认 Ollama 正在运行且端口正确',503);}
  }
  async scan(){
    if(this.scanning)return this.scanning;
    const base=this.base,revision=this.world.getMeta('ollama_revision');
    this.scanning=(async()=>{
      try{
        const result=await this.request('/api/tags',undefined,{base});if(!Array.isArray(result.models))throw new WorldError('Ollama 模型列表格式无效',502);
        const models=[];
        for(const entry of result.models){
          const name=entry.name||entry.model;if(typeof name!=='string'||name.length>200)continue;
          let info=entry;if(!Array.isArray(entry.capabilities)){try{info={...entry,...await this.request('/api/show',{model:name},{base})};}catch{/* Catalog still shows a model when capability inspection is unavailable. */}}
          const capabilities=Array.isArray(info.capabilities)?info.capabilities.filter(c=>typeof c==='string'):[];
          const local=Number(entry.size)>0&&!entry.remote_host&&!info.remote_host&&!info.remote_model&&!/(?:[:\-])cloud(?:$|:)/i.test(name);
          const canChat=local&&(capabilities.length?capabilities.includes('completion'):!/(?:embed|embedding|rerank)/i.test(name));
          const contextLength=Number(info.details?.context_length||Object.entries(info.model_info||{}).find(([key])=>key.endsWith('.context_length'))?.[1])||null;
          models.push({name,size:Number(entry.size)||0,modifiedAt:entry.modified_at||null,digest:String(entry.digest||''),family:info.details?.family||'',parameters:info.details?.parameter_size||'',quantization:info.details?.quantization_level||'',contextLength,capabilities,canChat,local,reason:!local?'云端或未落盘模型，不作为本地推理模型开放':!canChat?'不是可用于居民决策的文本生成模型':null});
        }
        const catalog={models,available:true,updatedAt:new Date().toISOString(),error:null};
        if(this.world.getMeta('ollama_revision')===revision&&this.base===base){this.world.setMeta('ollama_catalog',JSON.stringify(catalog));this.world.touch();}
        return this.public(true);
      }catch(error){if(this.world.getMeta('ollama_revision')===revision){this.world.setMeta('ollama_catalog',JSON.stringify({...this.catalog(),available:false,updatedAt:new Date().toISOString(),error:error.message}));this.world.touch();}throw error;}
      finally{this.scanning=null;}
    })();return this.scanning;
  }
  select(userId,{model,timeoutSeconds=180}){
    if(!this.enabled)throw new WorldError('管理员尚未开放本地模型',403);
    const catalog=this.catalog();if(!catalog.available)throw new WorldError('本地模型服务尚未就绪，请管理员刷新列表',503);
    if(typeof model!=='string'||!catalog.models.some(m=>m.name===model&&m.canChat))throw new WorldError('请选择列表中已安装且可用于对话的本地模型');
    const seconds=Number(timeoutSeconds);if(!Number.isInteger(seconds)||seconds<30||seconds>600)throw new WorldError('本地模型等待时间需要为 30–600 秒的整数');
    this.world.db.prepare("INSERT INTO model_preferences VALUES(?,'ollama',?,?,?) ON CONFLICT(user_id) DO UPDATE SET provider='ollama',local_model=excluded.local_model,timeout_ms=excluded.timeout_ms,revision=excluded.revision").run(userId,model,seconds*1000,randomUUID());this.world.touch();
  }
  useApi(userId){this.world.db.prepare("INSERT INTO model_preferences VALUES(?,'api','',180000,?) ON CONFLICT(user_id) DO UPDATE SET provider='api',revision=excluded.revision").run(userId,randomUUID());this.world.touch();}
  ready(userId){const preference=this.preference(userId);return Boolean(this.enabled&&this.catalog().available&&preference?.provider==='ollama'&&this.catalog().models.some(m=>m.name===preference.local_model&&m.canChat));}
  configuration(userId){
    if(!this.ready(userId))throw new WorldError('所选本地模型暂不可用，请检查管理员共享开关和已安装模型列表',503);
    const pref=this.preference(userId),model=this.catalog().models.find(m=>m.name===pref.local_model);
    return {provider:'ollama',model:pref.local_model,base:this.base,timeoutMs:pref.timeout_ms,revision:`${pref.revision}:${this.world.getMeta('ollama_revision')}:${model.digest}`};
  }
  sharedConfiguration(model){
    const entry=this.catalog().models.find(m=>m.name===model&&m.canChat);
    if(!this.enabled||!this.catalog().available||!entry)throw new WorldError('管理员选择的本地模型不可用，请检查共享开关并刷新模型列表',503);
    return {provider:'ollama',model,base:this.base,timeoutMs:180000,revision:`${this.world.getMeta('ollama_revision')}:${entry.digest}`};
  }
  isCurrent(userId,config){if(!this.ready(userId))return false;return this.configuration(userId).revision===config.revision;}
  async complete(config,messages){
    if(!this.enabled)throw new WorldError('管理员已关闭本地模型共享',403);
    if(this.busy)throw new WorldError('本机模型正在处理其他请求，请稍后再试',409);
    this.busy=true;this.world.touch();
    try{
      const model=this.catalog().models.find(m=>m.name===config.model);
      if(model?.contextLength&&model.contextLength<LOCAL_CONTEXT_SIZE)throw new WorldError('该模型上下文小于固定 8192 摘要窗口，请选择支持该窗口的模型');
      const qwen3=/^qwen3/i.test(model?.family||''),prepared=summaryMessages(messages,{reservedBytes:qwen3?32:0}).map(m=>({...m}));let context;try{context=JSON.parse(prepared.find(m=>m.role==='user')?.content);}catch{}
      const format=context?.contextWindow?decisionSchema(context):'json';
      if(qwen3){const last=[...prepared].reverse().find(m=>m.role==='user');if(last)prepared[prepared.indexOf(last)]={...last,content:last.content+'\n/no_think'};}
      let rawQwen=false;
      if(qwen3){const cacheKey=`${config.model}:${model.digest}`;if(!this.templateCompatibility.has(cacheKey)){const info=await this.request('/api/show',{model:config.model},{base:config.base});this.templateCompatibility.set(cacheKey,/^qwen3/i.test(info.details?.family||model.family||'')&&typeof info.template==='string'&&info.template.includes('<｜User｜>')&&!info.template.includes('<|im_start|>'));}rawQwen=this.templateCompatibility.get(cacheKey);}
      const options={temperature:/^deepseek-r1/i.test(config.model)?0.6:0.2,num_predict:1024,num_ctx:LOCAL_CONTEXT_SIZE};
      let result;
      if(rawQwen){
        // Some imported Qwen3 weights retain a DeepSeek chat template. Render
        // the matching token format per request; never rewrite the model file.
        const escape=text=>text.replaceAll('<|','‹|').replaceAll('<｜','‹｜');
        const prompt=prepared.map(m=>`<|im_start|>${m.role}\n${escape(m.content)}<|im_end|>\n`).join('')+'<|im_start|>assistant\n<think>\n\n</think>\n\n';
        result=await this.request('/api/generate',{model:config.model,prompt,raw:true,stream:false,format,think:false,keep_alive:'5m',options:{...options,stop:['<|im_end|>','<|endoftext|>']}},{base:config.base,timeoutMs:config.timeoutMs});
        result={...result,message:{content:result.response}};
      }else result=await this.request('/api/chat',{model:config.model,messages:prepared,stream:false,format,think:false,keep_alive:'5m',options},{base:config.base,timeoutMs:config.timeoutMs});
      if(result.done_reason==='length'&&!result.message?.content?.trim())throw new WorldError('模型输出预算被思考过程耗尽，未生成行动JSON；请检查模型模板的关闭思考支持',502);
      let content=result.message?.content;if(typeof content!=='string')throw new WorldError('本地模型没有返回文本，请选择支持对话的模型',502);
      content=content.replace(/<think>[\s\S]*?<\/think>/g,'').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
      let choice;try{choice=JSON.parse(content);}catch{throw new WorldError('本地模型未返回有效 JSON，可能输出被截断或模型不适合结构化决策',502);}
      if(!choice||typeof choice!=='object'||Array.isArray(choice))throw new WorldError('本地模型输出必须是 JSON 对象',502);return choice;
    }finally{this.busy=false;this.world.touch();}
  }
}
