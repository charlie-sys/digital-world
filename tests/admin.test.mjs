import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { World } from '../lib/world.mjs';
import { createApp } from '../server.mjs';

function setup(){const w=new World(),admin=w.register('admin-user','test-password').user,user=w.register('normal-user','test-password').user,r=w.join(user.id,{name:'用户居民',goal:'建设图书馆'});return {w,admin,user,r};}
const manage=(w,admin,id,operation,extra={})=>w.adminManage(admin.id,id,{operation,reason:'管理员维护测试',idempotency_key:randomUUID(),...extra});
const total=w=>{const s=w.snapshot();return s.treasury+s.residents.reduce((n,r)=>n+r.balance,0)+s.projects.reduce((n,p)=>n+Number(p.value),0)+s.archivedBalance;};

test('administrator can manage residents, with audit records and no access to private content',()=>{
 const {w,admin,user,r}=setup();try{
  assert.throws(()=>w.adminResidents(user.id),/管理员/);assert.throws(()=>manage(w,user,r.id,'move',{location:'farm'}),/管理员/);
  w.memory(r.id,'PRIVATE-MEMORY');manage(w,admin,r.id,'move',{location:'farm'});assert.equal(w.resident(r.id).location,'farm');
  manage(w,admin,r.id,'assign_job',{job_id:'baker'});assert.equal(w.resident(r.id).job_id,'baker');assert.equal(w.resident(r.id).location,'bakery');
  manage(w,admin,r.id,'assign_job',{job_id:null});assert.equal(w.resident(r.id).job_id,null);
  manage(w,admin,r.id,'set_mode',{mode:'manual'});assert.equal(w.resident(r.id).mode,'manual');
  assert.throws(()=>manage(w,admin,r.id,'set_mode',{mode:'llm'}),/本人启用/);
  const data=w.adminResidents(admin.id);assert.equal(data.audit.length,4);assert.equal(data.audit[0].before.mode,'rules');assert.equal(data.audit[0].after.mode,'manual');assert.ok(!JSON.stringify(data).includes('PRIVATE-MEMORY'));assert.equal(w.detail(r.id).memories,undefined);
 }finally{w.close();}
});

test('suspension blocks actions, proposals, votes and autonomous decisions until restored',()=>{
 const {w,admin,r}=setup();try{
  manage(w,admin,r.id,'suspend');const before=w.resident(r.id);assert.throws(()=>w.action(r.id,'rest',{},'paused-action'),/暂停/);assert.throws(()=>w.vote(r.id,'proposal-garden','yes'),/暂停/);assert.throws(()=>w.propose(r.id,{title:'提案',description:'说明',budget:0}),/暂停/);
  w.advance();assert.equal(w.resident(r.id).balance,before.balance);assert.equal(w.resident(r.id).location,before.location);
  manage(w,admin,r.id,'resume');w.action(r.id,'rest',{},'resumed-action');assert.equal(w.resident(r.id).location,'homes');
 }finally{w.close();}
});

test('financial grants conserve money, retry once and roll back failed operations',()=>{
 const {w,admin,r}=setup();try{
  const start=total(w),treasury=Number(w.getMeta('treasury')),key=randomUUID(),body={operation:'grant',reason:'公共服务补助',amount:100,idempotency_key:key};
  const result=w.adminManage(admin.id,r.id,body);assert.deepEqual(w.adminManage(admin.id,r.id,body),result);assert.equal(w.resident(r.id).balance,300);assert.equal(Number(w.getMeta('treasury')),treasury-100);assert.equal(total(w),start);assert.equal(w.adminResidents(admin.id).audit.length,1);
  assert.throws(()=>w.adminManage(admin.id,r.id,{...body,amount:200}),/幂等键/);assert.throws(()=>manage(w,admin,r.id,'grant',{amount:-1}),/金额/);assert.throws(()=>manage(w,admin,r.id,'move',{location:'invalid'}),/目的地/);
  assert.equal(w.adminResidents(admin.id).audit.length,1);
  w.setMeta('treasury',0);assert.throws(()=>manage(w,admin,r.id,'grant',{amount:10}),/余额/);assert.equal(w.resident(r.id).balance,300);assert.equal(w.adminResidents(admin.id).audit.length,1);
 }finally{w.close();}
});

test('removal hides residents, stops participation, preserves assets and history, and can be restored',()=>{
 const {w,admin,user,r}=setup();try{
  w.action(r.id,'apply_job',{job_id:'baker'},'job');w.memory(r.id,'PRIVATE-MEMORY');w.vote(r.id,'proposal-garden','yes');const token=w.issueToken(r.id),start=total(w),balance=r.balance;
  assert.throws(()=>manage(w,admin,r.id,'remove'),/确认/);manage(w,admin,r.id,'remove',{confirm_remove:true});
  assert.ok(!w.snapshot().residents.some(x=>x.id===r.id));assert.equal(w.snapshot(user.id).me.removed,1);assert.equal(w.snapshot().archivedBalance,balance);assert.equal(total(w),start);assert.equal(w.tokenResident(token),undefined);assert.equal(w.resident(r.id).job_id,null);assert.equal(w.resident(r.id).mode,'manual');
  assert.equal(w.snapshot().proposals.find(p=>p.id==='proposal-garden').yes,3);assert.ok(w.adminResidents(admin.id).residents.find(x=>x.id===r.id).removed);assert.ok(w.detail(r.id,true).memories.some(x=>x.text==='PRIVATE-MEMORY'));
  assert.throws(()=>w.action(r.id,'rest',{},'removed-action'),/移出世界/);assert.throws(()=>w.propose(r.id,{title:'提案',description:'说明',budget:0}),/移出世界/);assert.throws(()=>w.vote(r.id,'proposal-garden','yes'),/移出世界/);assert.throws(()=>manage(w,admin,r.id,'resume'),/只能执行恢复/);
  const hunger=w.resident(r.id).hunger;w.advance();assert.equal(w.resident(r.id).hunger,hunger);assert.equal(w.resident(r.id).balance,balance);
  assert.equal(w.login(user.username,'test-password').user.id,user.id);assert.throws(()=>w.join(user.id,{name:'逃避移除',goal:'重新加入'}),/只能申请一个/);
  manage(w,admin,r.id,'restore');assert.equal(w.control(r.id).removed,0);assert.equal(w.control(r.id).suspended,0);assert.equal(w.resident(r.id).mode,'manual');assert.equal(w.resident(r.id).location,'square');assert.ok(w.snapshot().residents.some(x=>x.id===r.id));assert.equal(total(w),start);w.action(r.id,'rest',{},'restored-action');
 }finally{w.close();}
});

test('administrator self-removal is prevented and closed voting history is retained',()=>{
 const {w,admin}=setup();try{
  const own=w.join(admin.id,{name:'管理员居民',goal:'维护秩序'});assert.throws(()=>manage(w,admin,own.id,'remove',{confirm_remove:true}),/自己的居民/);assert.equal(w.control(own.id).removed,0);
  w.db.prepare("UPDATE proposals SET status='rejected' WHERE id='proposal-garden'").run();manage(w,admin,'seed-1','remove',{confirm_remove:true});assert.equal(w.snapshot().proposals[0].yes,3);assert.equal(w.resident('seed-1').name,'林溪');
 }finally{w.close();}
});

test('admin endpoints enforce sessions, role, CSRF and suspension for external agents',async()=>{
 const app=createApp();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 const req=(path,body,cookie,headers={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  const register=async username=>{const res=await req('/api/register',{username,password:'test-password'});return {cookie:res.headers.get('set-cookie').split(';')[0],user:(await res.json()).user};};
  const admin=await register('http-admin'),user=await register('http-member');const joined=await req('/api/join',{name:'HTTP居民',goal:'建设图书馆'},user.cookie),r=await joined.json();const token=app.world.issueToken(r.id);
  assert.equal((await req('/api/admin/residents')).status,401);assert.equal((await req('/api/admin/residents',undefined,user.cookie)).status,403);assert.equal((await req('/api/admin/residents',undefined,null,{Authorization:`Bearer ${token}`})).status,401);
  const body={operation:'suspend',reason:'运营维护',idempotency_key:randomUUID()};
  assert.equal((await req(`/api/admin/residents/${r.id}`,body,user.cookie)).status,403);assert.equal((await req(`/api/admin/residents/${r.id}`,body,admin.cookie,{Origin:'https://evil.example'})).status,403);assert.equal((await req(`/api/admin/residents/${r.id}`,body,admin.cookie)).status,200);
  assert.equal((await req('/api/actions',{action:'rest',parameters:{},idempotency_key:'external-paused'},null,{Authorization:`Bearer ${token}`})).status,403);assert.equal((await req('/api/mode',{mode:'rules'},user.cookie)).status,403);
  const data=await (await req('/api/admin/residents',undefined,admin.cookie)).json();assert.equal(data.audit.length,1);assert.ok(!data.residents.some(r=>r.memories||r.user_id));
  assert.equal((await req(`/api/admin/residents/${r.id}`,{operation:'remove',confirm_remove:true,reason:'移除测试',idempotency_key:randomUUID()},admin.cookie)).status,200);
  assert.equal((await req('/api/agent/observe',undefined,null,{Authorization:`Bearer ${token}`})).status,401);
 }finally{await new Promise(r=>app.server.close(r));app.world.close();}
});

test('an in-flight model decision cannot execute after administrator removal',async()=>{
 let release,received;const arrived=new Promise(resolve=>received=resolve);
 const provider=createServer(async(req,res)=>{for await(const chunk of req){}release=()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'{"action":"move","parameters":{"location":"farm"}}'}}]}));};received();});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));const app=createApp({allowLocalModels:true});
 try{
  const admin=app.world.register('admin-inflight','test-password').user,user=app.world.register('member-inflight','test-password').user,r=app.world.join(user.id,{name:'模型居民',goal:'种植'});
  app.models.save(user.id,{base:`http://127.0.0.1:${provider.address().port}/v1`,model:'test-model',key:'test-secret'});app.world.db.prepare("UPDATE residents SET mode='llm' WHERE id=?").run(r.id);
  const advancing=app.advance();await arrived;manage(app.world,admin,r.id,'remove',{confirm_remove:true});release();await advancing;
  assert.equal(app.world.resident(r.id).location,'square');assert.equal(app.world.control(r.id).removed,1);assert.equal(app.world.db.prepare("SELECT count(*) n FROM actions WHERE resident_id=? AND key LIKE 'llm:%'").get(r.id).n,0);
 }finally{app.server.close();app.world.close();await new Promise(r=>provider.close(r));}
});
