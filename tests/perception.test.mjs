import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../lib/world.mjs';
import { decisionProblem, PROMPT_VERSION } from '../lib/perception.mjs';
import { createApp } from '../server.mjs';

function setup(){const w=new World(),a=w.register('perception-a','test-password').user,b=w.register('perception-b','test-password').user,c=w.register('perception-c','test-password').user;return {w,a:w.join(a.id,{name:'甲',goal:'维护公共图书馆'}),b:w.join(b.id,{name:'乙',goal:'建设社区花园'}),c:w.join(c.id,{name:'丙',goal:'开面包店'})};}

test('world observation refreshes public global state but never another residents private memory or conversations',()=>{
 const {w,a,b,c}=setup();try{
  w.memory(b.id,'OTHER-PRIVATE-MEMORY');w.action(b.id,'move',{location:'farm'},'move-b');w.action(b.id,'talk',{recipient_id:c.id,content:'PRIVATE-B-C-DIALOGUE'},'talk-private');
  const before=w.observe(a.id);assert.equal(before.promptVersion,PROMPT_VERSION);assert.equal(before.residents.find(r=>r.id===b.id).location,'farm');assert.equal(before.economy.treasury,w.snapshot().treasury);assert.ok(before.systemPrompt.includes('饥饿>=75'));assert.ok(before.actionCatalog.talk);assert.ok(!JSON.stringify(before).includes('OTHER-PRIVATE-MEMORY'));assert.ok(!JSON.stringify(before).includes('PRIVATE-B-C-DIALOGUE'));
  w.action(b.id,'move',{location:'library'},'move-b2');w.vote(b.id,'proposal-garden','yes');const after=w.observe(a.id);assert.ok(after.revision>before.revision);assert.equal(after.residents.find(r=>r.id===b.id).location,'library');assert.equal(after.proposals.find(p=>p.id==='proposal-garden').yes,before.proposals.find(p=>p.id==='proposal-garden').yes+1);assert.ok(after.residents.some(r=>r.id==='seed-12'));
 }finally{w.close();}
});

test('direct conversations are durable, scoped, idempotent and can be replied to only by the recipient',()=>{
 const {w,a,b,c}=setup();try{
  const parameters={recipient_id:b.id,content:'你好，你在哪里？'};w.action(a.id,'talk',parameters,'hello');w.action(a.id,'talk',parameters,'hello');assert.equal(w.inbox(a.id).length,1);assert.equal(w.inbox(b.id).length,1);assert.equal(w.inbox(c.id).length,0);assert.equal(w.detail(b.id).messages,undefined);
  assert.ok(!JSON.stringify(w.snapshot().events).includes(parameters.content));assert.ok(w.detail(b.id,true).memories.some(m=>m.text.includes(parameters.content)));
  const original=w.inbox(b.id)[0];assert.throws(()=>w.action(c.id,'talk',{recipient_id:a.id,content:'冒充回复',reply_to_id:original.id},'forged'),/不属于/);
  w.action(b.id,'talk',{recipient_id:a.id,content:'我在中央广场。',reply_to_id:original.id},'reply');assert.equal(w.inbox(a.id).length,2);assert.equal(w.inbox(a.id).find(m=>m.id===original.id).acknowledged,1);assert.throws(()=>w.action(b.id,'talk',{recipient_id:a.id,content:'重复回复',reply_to_id:original.id},'reply2'),/已经回复/);
  assert.throws(()=>w.action(a.id,'talk',{recipient_id:a.id,content:'自己说话'},'self'),/其他居民/);
 }finally{w.close();}
});

test('rule residents answer status inquiries truthfully without automatic reply loops',()=>{
 const {w,a}=setup();try{
  w.db.prepare("UPDATE residents SET mode='manual' WHERE id=?").run(a.id);w.db.prepare("UPDATE residents SET hunger=10,energy=90 WHERE id='seed-1'").run();
  w.action(a.id,'talk',{recipient_id:'seed-1',content:'请告诉我你的位置和身体状态。'},'ask');w.advance();
  const reply=w.inbox(a.id).find(m=>m.sender_id==='seed-1');assert.ok(reply?.reply_to_id);assert.match(reply.content,/中央广场/);assert.match(reply.content,/精力 90/);assert.match(reply.content,/饥饿 12/);
  w.advance();assert.equal(w.inbox(a.id).filter(m=>m.sender_id==='seed-1').length,1);
 }finally{w.close();}
});

test('model decisions reject obvious self-contradictions, duplicate votes and irrelevant purchases',()=>{
 const {w,a}=setup();try{
  assert.match(decisionProblem(w,a.id,{action:'move',parameters:{location:'square'}}),/原地移动/);
  w.db.prepare('UPDATE residents SET hunger=90 WHERE id=?').run(a.id);
  assert.match(decisionProblem(w,a.id,{action:'buy',parameters:{item_id:'tools',quantity:1}}),/先购买食物/);
  w.addItem(a.id,'bread',1);assert.match(decisionProblem(w,a.id,{action:'work',parameters:{}}),/饥饿|优先进食/);assert.equal(decisionProblem(w,a.id,{action:'eat',parameters:{}}),null);
  w.db.prepare('UPDATE residents SET hunger=10,energy=10 WHERE id=?').run(a.id);assert.match(decisionProblem(w,a.id,{action:'work',parameters:{}}),/精力不足/);
  w.vote(a.id,'proposal-garden','yes');assert.match(decisionProblem(w,a.id,{action:'vote',parameters:{proposal_id:'proposal-garden',choice:'yes'}}),/精力不足/);
  w.db.prepare('UPDATE residents SET energy=80 WHERE id=?').run(a.id);assert.match(decisionProblem(w,a.id,{action:'vote',parameters:{proposal_id:'proposal-garden',choice:'yes'}}),/重复投票/);
 }finally{w.close();}
});

test('proposing and voting are available as idempotent agent actions',()=>{
 const {w,a}=setup();try{
  const p={title:'共享书架',description:'为小镇补充公共知识资源',budget:20};w.action(a.id,'propose',p,'proposal-action');w.action(a.id,'propose',p,'proposal-action');assert.equal(w.snapshot().proposals.filter(p=>p.author_id===a.id).length,1);
  w.action(a.id,'vote',{proposal_id:'proposal-garden',choice:'yes'},'vote-action');assert.equal(w.snapshot().proposals.find(p=>p.id==='proposal-garden').yes,4);
 }finally{w.close();}
});

test('activity reports actual actions, confirmed movement endpoints and stable timestamps',()=>{
 const {w,a}=setup();try{
  w.action(a.id,'move',{location:'farm'},'walk');const first=w.detail(a.id).activity;assert.equal(first.action,'move');assert.equal(first.from_location,'square');assert.equal(first.to_location,'farm');assert.ok(first.ends_ms>first.started_ms);assert.equal(w.resident(a.id).location,'farm');assert.deepEqual(w.detail(a.id).activity,first);assert.ok(w.publicResidents().find(r=>r.id===a.id).activity);
 }finally{w.close();}
});

test('perception and messages APIs are resident-scoped, including external agents',async()=>{
 const app=createApp();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 try{
  assert.equal((await fetch(base+'/api/perception')).status,401);
  const a=app.world.register('http-perception-a','test-password').user,b=app.world.register('http-perception-b','test-password').user,ra=app.world.join(a.id,{name:'HTTP甲',goal:'种植'}),rb=app.world.join(b.id,{name:'HTTP乙',goal:'烘焙'}),token=app.world.issueToken(ra.id);
  app.world.action(rb.id,'talk',{recipient_id:ra.id,content:'这是给甲的消息'},'message');
  const headers={Authorization:`Bearer ${token}`};const observation=await (await fetch(base+'/api/agent/observe',{headers})).json();assert.equal(observation.self.id,ra.id);assert.equal(observation.self.messages[0].content,'这是给甲的消息');assert.equal(observation.residents.length,14);assert.ok(observation.systemPrompt);
  const messages=await (await fetch(base+'/api/messages',{headers})).json();assert.equal(messages.messages.length,1);
 }finally{await new Promise(r=>app.server.close(r));app.world.close();}
});

test('server-sent updates carry only a public revision and world tick',async()=>{
 const app=createApp();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`,controller=new AbortController();let reader;
 try{
  const response=await fetch(base+'/api/stream',{signal:controller.signal});assert.match(response.headers.get('content-type'),/text\/event-stream/);reader=response.body.getReader();const initial=new TextDecoder().decode((await reader.read()).value);assert.match(initial,/"revision":/);assert.ok(!initial.includes('memories'));
  const before=app.world.revision;app.world.action('seed-1','move',{location:'farm'},'stream-action');assert.ok(app.world.revision>before);
  const next=await Promise.race([reader.read(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('No real-time update')),2500).unref())]);const payload=new TextDecoder().decode(next.value);assert.ok(payload.includes(`"revision":${app.world.revision}`));assert.ok(!payload.includes('sender_id'));
 }finally{await reader?.cancel();controller.abort();app.closeStreams();await new Promise(r=>app.server.close(r));app.world.close();}
});
