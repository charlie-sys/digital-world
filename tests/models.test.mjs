import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { privateAddress, modelFailureReason } from '../lib/models.mjs';

test('public IPv4 and IPv6 remain allowed while private and mapped IPv6 addresses are blocked',()=>{
 for(const ip of ['1.1.1.1','8.8.8.8','47.94.20.201','101.201.58.201','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(privateAddress(ip),false,ip);
 for(const ip of ['0.0.0.0','10.0.0.1','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','198.18.0.1','224.0.0.1','255.255.255.255','::1','::','::ffff:127.0.0.1','::ffff:8.8.8.8','fe80::1','fc00::1','invalid'])assert.equal(privateAddress(ip),true,ip);
});
test('failure explanations are actionable without exposing upstream secrets',()=>{
 assert.match(modelFailureReason(new Error('Model HTTP 401')),/密钥/);
 assert.match(modelFailureReason(new Error('Model HTTP 429')),/额度/);
 assert.match(modelFailureReason(new Error('Private model destination rejected')),/DNS/);
 assert.match(modelFailureReason(new Error('Model timeout')),/60 秒/);
 assert.match(modelFailureReason(Object.assign(new Error('Model timeout'),{timeoutMs:90000})),/90 秒/);
 assert.match(modelFailureReason(Object.assign(new Error('secret'),{code:'ENOTFOUND'})),/DNS/);
 assert.ok(!modelFailureReason(new Error('provider body with secret-token')).includes('secret-token'));
});

test('request deadlines are per account, validated and preserve existing credentials when edited',()=>{
 const app=createApp();try{
  const a=app.world.register('timeout-a','test-password').user,b=app.world.register('timeout-b','test-password').user;
  const settings={base:'https://provider.example/v1',model:'model-a',key:'secret-a'};
  app.models.save(a.id,settings);app.models.save(b.id,{...settings,key:'secret-b'});
  assert.equal(app.models.public(a.id).timeoutSeconds,60);
  app.models.save(a.id,{...settings,key:'',timeoutSeconds:'90'});assert.equal(app.models.get(a.id).timeoutMs,90000);assert.equal(app.models.get(a.id).key,'secret-a');assert.equal(app.models.get(b.id).timeoutMs,60000);
  for(const timeoutSeconds of [0,9,181,10.5,'bad',null])assert.throws(()=>app.models.save(a.id,{...settings,timeoutSeconds}),/10–180/);
  app.models.save(a.id,{...settings,key:''});assert.equal(app.models.get(a.id).timeoutMs,90000);
 }finally{app.server.close();app.world.close();}
});

test('slow responses succeed within configured deadlines; elapsed deadline aborts exactly one request',async()=>{
 let calls=0;const provider=createServer(async(req,res)=>{for await(const ignored of req){}calls++;setTimeout(()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));},180);});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));const app=createApp({allowLocalModels:true});
 const config={base:`http://127.0.0.1:${provider.address().port}/v1`,model:'test-model',key:'test-key'};
 try{
  await assert.rejects(()=>app.models.complete({...config,timeoutMs:60},[]),error=>error.message==='Model timeout'&&error.timeoutMs===60);
  assert.equal(calls,1);assert.deepEqual(await app.models.complete({...config,timeoutMs:1000},[]),{ok:true});assert.equal(calls,2);
 }finally{app.server.close();app.world.close();await new Promise(r=>provider.close(r));}
});

test('model settings are authenticated, encrypted, account-scoped, and never return keys',async()=>{
 const app=createApp();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 const req=async(path,body,cookie)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  assert.equal((await req('/api/model')).status,401);
  const register=async username=>{const res=await req('/api/register',{username,password:'test-password'});return {cookie:res.headers.get('set-cookie').split(';')[0],user:(await res.json()).user};};
  const a=await register('alice'),b=await register('bob');
  await req('/api/join',{name:'甲居民',goal:'建书屋'},a.cookie);await req('/api/join',{name:'乙居民',goal:'种花'},b.cookie);
  assert.equal((await req('/api/mode',{mode:'llm'},b.cookie)).status,400);
  const saved=await req('/api/model',{base:'https://alice.example/v1',model:'alice-model',key:'alice-secret',user_id:b.user.id},a.cookie);assert.equal(saved.status,200);
  const publicA=await saved.json();assert.equal(publicA.keyConfigured,true);assert.ok(!JSON.stringify(publicA).includes('alice-secret'));
  assert.equal((await (await req('/api/model',undefined,b.cookie)).json()).configured,false);
  assert.equal((await req('/api/mode',{mode:'llm'},b.cookie)).status,400);
  await req('/api/model',{base:'https://bob.example/v1',model:'bob-model',key:'bob-secret'},b.cookie);
  assert.equal(app.models.get(a.user.id).key,'alice-secret');assert.equal(app.models.get(b.user.id).key,'bob-secret');
  await req('/api/model',{base:'https://alice.example/v2',model:'alice-new',key:''},a.cookie);assert.equal(app.models.get(a.user.id).key,'alice-secret');
  const dump=JSON.stringify(app.world.db.prepare('SELECT * FROM model_settings').all());assert.ok(!dump.includes('alice-secret'));assert.ok(!dump.includes('bob-secret'));
  for(const cookie of [a.cookie,b.cookie,undefined]){const snapshot=await (await req('/api/world',undefined,cookie)).json();const json=JSON.stringify(snapshot);assert.ok(!json.includes('alice-secret')&&!json.includes('bob-secret'));}
  assert.equal((await req('/api/mode',{mode:'llm'},a.cookie)).status,200);
  await req('/api/model/delete',{},a.cookie);assert.equal(app.models.get(a.user.id),null);assert.equal(app.world.residentFor(a.user.id).mode,'manual');assert.equal(app.models.get(b.user.id).key,'bob-secret');
  const agent=app.world.issueToken(app.world.residentFor(b.user.id).id);
  const denied=await fetch(base+'/api/model',{headers:{Authorization:`Bearer ${agent}`}});assert.equal(denied.status,401);
  assert.equal((await req('/api/model',{base:'https://example.com/v1',model:'x'},a.cookie)).status,400);
 }finally{await new Promise(r=>app.server.close(r));app.world.close();}
});

test('two residents use their own provider credentials, model and private context',async()=>{
 const calls=[];const provider=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));calls.push({key:req.headers.authorization,...body});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({action:'move',parameters:{location:body.model==='model-a'?'farm':'library'}})}}]}));});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));const app=createApp({allowLocalModels:true});
 try{
  for(const name of ['a','b']){const {user}=app.world.register(`user-${name}`,'test-password');const r=app.world.join(user.id,{name:`居民${name}`,goal:`独立目标${name}`});app.world.memory(r.id,`secret-memory-${name}`);app.models.save(user.id,{base:`http://127.0.0.1:${provider.address().port}/v1`,model:`model-${name}`,key:`secret-${name}`});app.world.db.prepare("UPDATE residents SET mode='llm' WHERE id=?").run(r.id);}
  const residents=app.world.publicResidents().filter(r=>r.name==='居民a'||r.name==='居民b');for(const r of residents)app.world.db.prepare("UPDATE residents SET job_id=?,location='square' WHERE id=?").run(r.name==='居民a'?'farmer':'librarian',r.id);for(let i=0;i<30;i++){const tick=9+24*i;app.world.setMeta('tick',tick);if(residents.every(r=>app.world.observe(r.id).behavior.selected?.kind==='duty')){app.world.setMeta('tick',tick-1);break;}}
  await app.advance();assert.equal(calls.length,2);
  for(const name of ['a','b']){const call=calls.find(c=>c.model===`model-${name}`);assert.equal(call.key,`Bearer secret-${name}`);const context=JSON.parse(call.messages[1].content);assert.equal(context.self.goal,`独立目标${name}`);assert.ok(JSON.stringify(context.self.memories).includes(`secret-memory-${name}`));assert.ok(!JSON.stringify(context).includes(`secret-memory-${name==='a'?'b':'a'}`));assert.equal(app.world.resident(context.self.id).location,name==='a'?'farm':'library');}
 }finally{app.server.close();app.world.close();await new Promise(r=>provider.close(r));}
});

test('encrypted configuration survives server restart with its data-directory key',()=>{
 const directory=mkdtempSync(join(tmpdir(),'morrow-model-')),database=join(directory,'world.sqlite'),a=createApp({database});
 const {user}=a.world.register('persistent-user','test-password');a.models.save(user.id,{base:'https://provider.example/v1',model:'model-p',key:'persistent-secret'});a.server.close();a.world.close();
 const b=createApp({database});try{assert.equal(b.models.get(user.id).key,'persistent-secret');assert.equal(readFileSync(join(directory,'model-encryption.key')).length,32);assert.ok(!readFileSync(database).includes(Buffer.from('persistent-secret')));}finally{b.server.close();b.world.close();}
});

test('public model endpoints reject local networks, credentials in URLs and invalid keys',async()=>{
 const app=createApp();try{
  const {user}=app.world.register('network-user','test-password');
  for(const base of ['http://127.0.0.1:3000/v1','https://127.0.0.1/v1','https://169.254.169.254/v1','https://[::1]/v1','https://user:pass@example.com/v1','https://example.com/v1?key=secret'])assert.throws(()=>app.models.save(user.id,{base,model:'m',key:'k'}));
  assert.throws(()=>app.models.save(user.id,{base:'https://example.com/v1',model:'m',key:'bad\r\nkey'}));
  await assert.rejects(()=>app.models.complete({base:'https://127.0.0.1/v1',model:'m',key:'k'},[]));
 }finally{app.server.close();app.world.close();}
});

test('connection tests use the saved config without resident data and sanitize provider errors',async()=>{
 let fail=false,body;const provider=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);body=JSON.parse(Buffer.concat(chunks));if(fail){res.writeHead(401);return res.end('do not expose secret');}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}));});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));const app=createApp({allowLocalModels:true});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 try{
  const registered=await fetch(base+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'connection-user',password:'test-password'})});const cookie=registered.headers.get('set-cookie').split(';')[0],{user}=await registered.json();app.models.save(user.id,{base:`http://127.0.0.1:${provider.address().port}/v1`,model:'m',key:'test-secret'});
  const run=()=>fetch(base+'/api/model/test',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{}'});
  assert.equal((await run()).status,200);assert.ok(!JSON.stringify(body).includes('memories'));fail=true;const failed=await run();assert.equal(failed.status,502);assert.ok(!(await failed.text()).includes('do not expose secret'));
 }finally{await new Promise(r=>app.server.close(r));app.world.close();await new Promise(r=>provider.close(r));}
});
