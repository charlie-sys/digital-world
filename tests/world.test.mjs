import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { World } from '../lib/world.mjs';
import { createApp } from '../server.mjs';
import { createServer } from 'node:http';

let serial=0;
const citizen=w=>{const n=++serial;const {user}=w.register(`test-user-${n}`,'test-password-123');return {user,r:w.join(user.id,{name:`测试居民${n}`,goal:'开一家社区面包店'})};};
const total=w=>{const s=w.snapshot();return s.treasury+s.residents.reduce((a,r)=>a+r.balance,0)+s.projects.reduce((a,p)=>a+Number(p.value),0)+s.community.accountTotal;};
test('registration, login, unique citizenship and private memory',()=>{
 const w=new World();try{
  const {user,r}=citizen(w);assert.equal(w.getMeta('owner'),user.id);assert.equal(w.resident(r.id).balance,200);
  assert.throws(()=>w.join(user.id,{name:'另一个身份',goal:'目标'}),/只能/);
  assert.equal(w.login(user.username,'test-password-123').user.id,user.id);
  assert.throws(()=>w.login(user.username,'wrong-password'),/密码/);
  assert.equal(w.detail(r.id).memories,undefined);assert.equal(w.detail(r.id,true).memories.length,1);
 }finally{w.close();}
});
test('work is paid once per hour and stock follows production',()=>{
 const w=new World();try{
  const {r}=citizen(w),initial=total(w);
  w.action(r.id,'apply_job',{job_id:'baker'},'hire');
  const bread=w.snapshot().goods.find(g=>g.id==='bread').stock;
  w.action(r.id,'work',{},'work-1');assert.equal(w.resident(r.id).balance,218);
  assert.equal(w.snapshot().goods.find(g=>g.id==='bread').stock,bread+3);
  assert.throws(()=>w.action(r.id,'work',{},'work-2'),/已经完成工作/);
  assert.equal(total(w),initial);
 }finally{w.close();}
});
test('purchase is atomic and retries do not double charge',()=>{
 const w=new World();try{
  const {r}=citizen(w);w.action(r.id,'move',{location:'market'},'move');
  const before=w.snapshot(),item=before.goods.find(g=>g.id==='bread');
  const result=w.action(r.id,'buy',{item_id:'bread',quantity:2},'purchase-1');
  assert.deepEqual(w.action(r.id,'buy',{item_id:'bread',quantity:2},'purchase-1'),result);
  assert.throws(()=>w.action(r.id,'buy',{item_id:'bread',quantity:1},'purchase-1'),/幂等键/);
  assert.equal(w.resident(r.id).balance,184);assert.equal(w.inventory(r.id)[0].quantity,2);
  assert.equal(w.snapshot().goods.find(g=>g.id==='bread').stock,item.stock-2);
  w.db.prepare("UPDATE goods SET stock=0 WHERE id='bread'").run();const balance=w.resident(r.id).balance;
  assert.throws(()=>w.action(r.id,'buy',{item_id:'bread'},'failed'),/库存/);assert.equal(w.resident(r.id).balance,balance);
  assert.throws(()=>w.action(r.id,'buy',{item_id:'tools',quantity:-1},'bad'),/数量/);
  w.action(r.id,'eat',{},'eat');assert.equal(w.inventory(r.id)[0].quantity,1);
 }finally{w.close();}
});

test('real HTTP model adapter receives identity and memory, applies valid actions and rejects fabricated ones',async()=>{
 let completion={action:'move',parameters:{location:'library'}},received;
 const provider=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);received=JSON.parse(Buffer.concat(chunks));assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer mock-secret');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(completion)}}]}));});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const app=createApp({allowLocalModels:true});
 try{
  const {r,user}=citizen(app.world);app.models.save(user.id,{base:`http://127.0.0.1:${provider.address().port}/v1`,key:'mock-secret',model:'test-model'});app.world.db.prepare("UPDATE residents SET mode='llm' WHERE id=?").run(r.id);
  app.world.db.prepare("UPDATE residents SET job_id='librarian',location='square' WHERE id=?").run(r.id);for(let i=0;i<30;i++){const tick=9+24*i;app.world.setMeta('tick',tick);if(app.world.observe(r.id).behavior.selected?.kind==='duty'){app.world.setMeta('tick',tick-1);break;}}
  await app.advance();assert.equal(app.world.resident(r.id).location,'library');
  const context=JSON.parse(received.messages[1].content);assert.equal(context.self.goal,r.goal);assert.ok(context.self.memories.length);assert.equal(received.model,'test-model');
  const balance=app.world.resident(r.id).balance;completion={action:'create_money',parameters:{amount:10000}};
  await app.advance();assert.equal(app.world.resident(r.id).balance,balance);
  assert.match(app.world.detail(r.id,true).memories[0].text,/未执行/);
  completion={action:'buy',parameters:{item_id:'bread',quantity:20}};
  await app.advance();assert.equal(app.world.resident(r.id).balance,balance);assert.equal(app.world.resident(r.id).mode,'llm');
  assert.ok(!JSON.stringify(app.world.snapshot()).includes('mock-secret'));
 }finally{app.server.close();app.world.close();await new Promise(r=>provider.close(r));}
});
test('failed wage payment rolls back production materials',()=>{
 const w=new World();try{
  const {r}=citizen(w);w.action(r.id,'apply_job',{job_id:'baker'},'job');w.setMeta('treasury',0);
  const goods=w.snapshot().goods;
  assert.throws(()=>w.action(r.id,'work',{},'fail'),/余额/);assert.deepEqual(w.snapshot().goods,goods);
 }finally{w.close();}
});
test('one vote per resident, quorum and funded project accounts',()=>{
 const w=new World();try{
  const {r}=citizen(w),initial=total(w);
  w.vote(r.id,'proposal-garden','no');w.vote(r.id,'proposal-garden','yes');
  assert.equal(w.snapshot().proposals[0].yes,4);assert.equal(w.snapshot().proposals[0].no,0);
  w.setMeta('tick',31);w.advance();
  const p=w.snapshot().proposals.find(p=>p.id==='proposal-garden');assert.equal(p.status,'passed');
  assert.equal(w.getMeta('project-proposal-garden'),'300');assert.equal(total(w),initial);
  assert.throws(()=>w.vote(r.id,p.id,'yes'),/截止/);
 }finally{w.close();}
});
test('240-hour autonomous simulation conserves money and nonnegative inventories',()=>{
 const w=new World();try{
  const initial=total(w);for(let i=0;i<240;i++)w.advance();
  assert.equal(total(w),initial);assert.equal(w.tick,248);
  const s=w.snapshot();assert.ok(s.goods.every(g=>g.stock>=0));assert.ok(s.residents.every(r=>r.energy>=0&&r.energy<=100&&r.hunger>=0&&r.hunger<=100&&r.balance>=0));
  assert.ok(w.db.prepare('SELECT count(*) n FROM ledger').get().n>100);
 }finally{w.close();}
});
test('world persists through close and reopen',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'morrow-test-')),'world.sqlite');
 const a=new World(path),{r}=citizen(a);a.advance();const money=total(a);a.close();
 const b=new World(path);try{assert.equal(b.tick,9);assert.equal(b.resident(r.id).name,r.name);assert.equal(total(b),money);assert.equal(b.snapshot().residents.length,13);}finally{b.close();}
});
test('agent credentials are hashed, scoped and revocable',()=>{
 const w=new World();try{
  const {r}=citizen(w),token=w.issueToken(r.id);assert.equal(w.tokenResident(token),r.id);
  assert.notEqual(w.db.prepare('SELECT token FROM agent_tokens').get().token,token);
  const replacement=w.issueToken(r.id);assert.equal(w.tokenResident(token),undefined);assert.equal(w.tokenResident(replacement),r.id);
 }finally{w.close();}
});
test('HTTP ownership, sessions, CSRF, private memories and agent identity',async()=>{
 const app=createApp();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 const request=async(path,body,cookie,headers={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  assert.equal((await request('/api/actions',{action:'rest',idempotency_key:'x'})).status,401);
  const signup=await request('/api/register',{username:'admin',password:'test-password'}),cookie=signup.headers.get('set-cookie').split(';')[0];assert.equal(signup.status,200);
  const joined=await request('/api/join',{name:'测试居民',goal:'维护世界'},cookie),resident=await joined.json();assert.equal(joined.status,201);
  const pub=await (await request(`/api/residents/${resident.id}`)).json();assert.equal(pub.memories,undefined);
  const mine=await (await request(`/api/residents/${resident.id}`,undefined,cookie)).json();assert.ok(mine.memories.length);
  const other=await request('/api/register',{username:'other',password:'test-password'}),otherCookie=other.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/advance',{},otherCookie)).status,403);
  assert.equal((await request('/api/running',{running:true},cookie,{Origin:'https://evil.example'})).status,403);
  const issued=await (await request('/api/agent/token',{},cookie)).json();
  const observed=await (await request('/api/agent/observe',undefined,null,{Authorization:`Bearer ${issued.token}`})).json();assert.equal(observed.self.id,resident.id);
  await request('/api/mode',{mode:'external'},cookie);
  const action=await request('/api/actions',{action:'rest',parameters:{},idempotency_key:'agent-test',resident_id:'seed-1'},null,{Authorization:`Bearer ${issued.token}`});assert.equal(action.status,200);
  assert.equal((await request('/api/advance',{},cookie)).status,200);
  assert.equal((await request('/.env')).status,404);
  await request('/api/logout',{},cookie);assert.equal((await request('/api/advance',{},cookie)).status,401);
 }finally{await new Promise(r=>app.server.close(r));app.world.close();}
});
