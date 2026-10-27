import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { ollamaBase } from '../lib/ollama.mjs';

async function fixture(){
 const calls=[];let chatErrors=[];let offline=false,delay=0,content='{"action":"rest","parameters":{}}';
 let entries=[{name:'small:latest',size:100,digest:'a',details:{family:'qwen',parameter_size:'1B'},capabilities:['completion']},{name:'large:latest',size:200,digest:'b'},{name:'embed:latest',size:50,capabilities:['embedding']},{name:'remote:cloud',size:0,capabilities:['completion']}];
 const service=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;calls.push({url:req.url,headers:req.headers,body});res.setHeader('Content-Type','application/json');if(offline){res.writeHead(503);res.end('private service secret');return;}if(req.url==='/api/tags')return res.end(JSON.stringify({models:entries}));if(req.url==='/api/show')return res.end(JSON.stringify({capabilities:['completion','thinking']}));if(chatErrors.length){const error=chatErrors.shift();res.writeHead(400);return res.end(JSON.stringify({error}));}await new Promise(r=>setTimeout(r,delay));res.end(JSON.stringify({message:{content,thinking:'ignored reasoning'}}));});
 await new Promise(r=>service.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${service.address().port}`,app=createApp({ollamaBase:base});
 const admin=app.world.register('local-admin','test-password').user,user=app.world.register('local-user','test-password').user;
 app.ollama.configure(admin.id,{base,enabled:true});await app.ollama.scan();
 return {app,admin,user,base,calls,setChatErrors:v=>chatErrors=v,setOffline:v=>offline=v,setDelay:v=>delay=v,setContent:v=>content=v,setEntries:v=>entries=v,async close(){app.closeStreams();await new Promise(r=>app.server.close(()=>r()));app.world.close();await new Promise(r=>service.close(r));}};
}
test('Ollama root is loopback-only and recognizes OLLAMA_HOST formats',()=>{
 for(const input of [':14434','localhost:14434','http://0.0.0.0:14434'])assert.equal(ollamaBase(input),'http://127.0.0.1:14434');
 assert.equal(ollamaBase('http://[::]:11434'),'http://[::1]:11434');
 for(const input of ['https://example.com','http://192.168.1.1:11434','http://127.0.0.1/api','http://user:pass@127.0.0.1','http://127.0.0.1?token=x'])assert.throws(()=>ollamaBase(input));
});
test('catalog reads tags and capabilities, blocks cloud/embedding choices and reports disconnection',async()=>{
 const f=await fixture();try{const {app,user,admin}=f,c=app.ollama.public();assert.equal(c.models.length,4);assert.equal(c.models.filter(m=>m.canChat).length,2);assert.ok(f.calls.some(c=>c.url==='/api/show'));
 for(const model of ['embed:latest','remote:cloud','missing'])assert.throws(()=>app.ollama.select(user.id,{model}));
 assert.throws(()=>app.ollama.configure(user.id,{base:f.base,enabled:false}),/管理员/);
 f.setOffline(true);await assert.rejects(()=>app.ollama.scan());assert.equal(app.ollama.public().available,false);assert.ok(!app.ollama.public().error.includes('private service secret'));assert.throws(()=>app.ollama.select(user.id,{model:'small:latest'}),/就绪/);
 app.ollama.configure(admin.id,{base:f.base,enabled:false});assert.deepEqual(app.ollama.public().models,[]);assert.equal(app.ollama.public(true).models.length,4);
 }finally{await f.close();}
});
test('each account selects its own model; API credentials survive switching and local inference is native',async()=>{
 const f=await fixture();try{const {app,user,admin}=f;
 app.models.save(user.id,{base:'https://example.com/v1',model:'paid',key:'private-key'});const apiConfig=app.models.get(user.id);
 app.ollama.select(user.id,{model:'small:latest',timeoutSeconds:240});app.ollama.select(admin.id,{model:'large:latest'});
 assert.equal(app.models.get(user.id).timeoutMs,240000);assert.equal(app.models.get(admin.id).model,'large:latest');assert.equal(app.models.isCurrent(user.id,apiConfig),false);
 const local=app.models.get(user.id);assert.equal(local.key,undefined);assert.equal(app.models.public(user.id).apiConfigured,true);
 f.setContent('<think>private reasoning</think>\n```json\n{"action":"rest","parameters":{}}\n```');assert.equal((await app.models.complete(local,[{role:'user',content:'synthetic'}])).action,'rest');
 const call=f.calls.find(c=>c.url==='/api/chat');assert.equal(call.headers.authorization,undefined);assert.equal(call.body.model,'small:latest');assert.equal(call.body.stream,false);assert.equal(call.body.think,false);assert.equal(call.body.format,'json');assert.ok(!JSON.stringify(call).includes('private-key'));
 app.ollama.useApi(user.id);assert.equal(app.models.get(user.id).key,'private-key');assert.equal(app.models.isCurrent(user.id,local),false);
 app.ollama.select(user.id,{model:'small:latest'});const r=app.world.join(user.id,{name:'本地居民',goal:'种花'});app.world.db.prepare("UPDATE residents SET mode='llm' WHERE id=?").run(r.id);app.models.delete(user.id);assert.equal(app.models.public(user.id).configured,true);assert.equal(app.world.resident(r.id).mode,'llm');
 app.ollama.configure(admin.id,{base:f.base,enabled:false});assert.equal(app.models.isCurrent(user.id,app.ollama.preference(user.id)),false);assert.throws(()=>app.models.get(user.id),/不可用/);
 }finally{await f.close();}
});
test('busy inference, malformed output, timeout and changed catalog never fall back to API',async()=>{
 const f=await fixture();try{const {app,user}=f;app.ollama.select(user.id,{model:'small:latest'});const config=app.models.get(user.id);f.setDelay(100);const pending=app.models.complete(config,[]);await assert.rejects(()=>app.models.complete(config,[]),/正在处理/);await pending;assert.equal(app.ollama.busy,false);
 await assert.rejects(()=>app.models.complete({...config,timeoutMs:10},[]),/超过/);assert.equal(app.ollama.busy,false);f.setDelay(0);f.setContent('not json');await assert.rejects(()=>app.models.complete(config,[]),/有效 JSON/);f.setContent('[]');await assert.rejects(()=>app.models.complete(config,[]),/JSON 对象/);
 f.setEntries([]);await app.ollama.scan();assert.equal(app.models.isCurrent(user.id,config),false);assert.equal(app.models.public(user.id).configured,false);assert.throws(()=>app.models.get(user.id),/不可用/);
 assert.equal(f.calls.filter(c=>c.url?.includes('completions')).length,0);
 }finally{await f.close();}
});
test('HTTP admin access is protected and user cannot configure another account or service root',async()=>{
 const f=await fixture();await new Promise(r=>f.app.server.listen(0,'127.0.0.1',r));const root=`http://127.0.0.1:${f.app.server.address().port}`;
 const req=(path,body,cookie)=>fetch(root+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 try{const login=async username=>{const r=await req('/api/login',{username,password:'test-password'});return r.headers.get('set-cookie').split(';')[0];};const ac=await login('local-admin'),uc=await login('local-user');
 assert.equal((await req('/api/ollama/models')).status,401);assert.equal((await req('/api/admin/ollama',undefined,uc)).status,403);assert.equal((await req('/api/admin/ollama',{base:f.base,enabled:false},uc)).status,403);assert.equal((await req('/api/admin/ollama/refresh',{},uc)).status,403);assert.equal((await req('/api/admin/ollama',undefined,ac)).status,200);
 const list=await (await req('/api/ollama/models',undefined,uc)).json();assert.equal(list.base,undefined);assert.equal(list.models.length,4);
 assert.equal((await req('/api/model/source',{provider:'ollama',model:'large:latest',user_id:f.admin.id,base:'https://evil.example'},uc)).status,200);assert.equal(f.app.models.get(f.user.id).model,'large:latest');assert.equal(f.app.ollama.preference(f.admin.id),undefined);
 const snapshot=await (await req('/api/world',undefined,uc)).json();assert.equal(snapshot.capabilities.model,'large:latest');assert.equal(snapshot.modelSettings.provider,'ollama');
 await req('/api/admin/ollama',{base:f.base,enabled:false},ac);assert.equal((await req('/api/model/source',{provider:'ollama',model:'small:latest'},uc)).status,403);
 }finally{await f.close();}
});
test('local provider preferences and catalog persist across restarts',async()=>{
 const database=join(mkdtempSync(join(tmpdir(),'morrow-ollama-')),'world.sqlite'),a=createApp({database,ollamaBase:':14434'});const user=a.world.register('persistent-local','test-password').user;
 a.ollama.configure(user.id,{base:':14434',enabled:true});a.world.setMeta('ollama_catalog',JSON.stringify({available:true,models:[{name:'persist:1b',canChat:true,digest:'d'}]}));a.ollama.select(user.id,{model:'persist:1b',timeoutSeconds:300});a.server.close();a.world.close();
 const b=createApp({database});try{assert.equal(b.models.get(user.id).model,'persist:1b');assert.equal(b.models.get(user.id).timeoutMs,300000);assert.equal(b.ollama.base,'http://127.0.0.1:14434');}finally{b.server.close();b.world.close();}
});
test('resident autonomous action uses native local model and discards a result after sharing closes',async()=>{
 const f=await fixture();try{const {app,user,admin}=f;const r=app.world.join(user.id,{name:'本地行动者',goal:'研究书籍'});app.ollama.select(user.id,{model:'small:latest'});app.world.db.prepare("UPDATE residents SET mode='llm' WHERE id=?").run(r.id);f.setContent('{"action":"move","parameters":{"location":"library"}}');app.world.db.prepare("UPDATE residents SET job_id='librarian',location='square' WHERE id=?").run(r.id);for(let i=0;i<30;i++){const tick=9+24*i;app.world.setMeta('tick',tick);if(app.world.observe(r.id).behavior.selected?.kind==='duty'){app.world.setMeta('tick',tick-1);break;}}await app.advance();assert.equal(app.world.resident(r.id).location,'library');assert.ok(f.calls.some(c=>c.url==='/api/chat'&&c.body.messages[1].content.includes(r.id)));
 f.setDelay(120);f.setContent('{"action":"move","parameters":{"location":"farm"}}');const pending=app.advance();app.ollama.configure(admin.id,{base:f.base,enabled:false});await pending;assert.equal(app.world.resident(r.id).location,'library');
 }finally{await f.close();}
});

test('local resident inference always uses the fixed summary window and required action schema',async()=>{
 const f=await fixture();try{const {app,user}=f,r=app.world.join(user.id,{name:'摘要测试',goal:'探索'});for(let i=0;i<30;i++)app.world.memory(r.id,'重复历史'.repeat(40));const {systemPrompt,...context}=app.world.observe(r.id);app.ollama.select(user.id,{model:'small:latest'});await app.models.complete(app.models.get(user.id),[{role:'system',content:systemPrompt},{role:'user',content:JSON.stringify(context)}]);const call=f.calls.find(c=>c.url==='/api/chat').body;assert.equal(call.options.num_ctx,8192);assert.deepEqual(call.format.required,['action','parameters']);assert.ok(JSON.parse(call.messages[1].content).contextWindow);assert.ok(Buffer.byteLength(JSON.stringify(call.messages))<=11000);
 f.setChatErrors(['request (9000 tokens) exceeds the available context size (8192 tokens), private prompt']);await assert.rejects(()=>app.models.complete(app.models.get(user.id),[]),e=>e.message.includes('9000 tokens')&&!e.message.includes('private prompt'));assert.equal(f.calls.filter(c=>c.url==='/api/chat').length,2);
 }finally{await f.close();}
});
