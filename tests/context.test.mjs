import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {summaryMessages,LOCAL_CONTEXT_SIZE} from '../lib/context.mjs';
const messages=o=>{const {systemPrompt,...context}=o;return [{role:'system',content:systemPrompt},{role:'user',content:JSON.stringify(context)}];};
test('archived proposals become outcome counts while live ballots and current residents remain actionable',()=>{
 const app=createApp();try{const {user}=app.world.register('archive-summary','test-password'),r=app.world.join(user.id,{name:'议事居民',goal:'照顾社区'}),o=app.world.observe(r.id);
 o.proposals=[...Array.from({length:30},(_,i)=>({id:`past-${i}`,title:'历史议案',description:'已经结束的详细讨论'.repeat(40),status:i%2?'rejected':'approved'})),{id:'live-ballot',title:'正在表决',status:'open',description:'需要保留',deadline:o.tick+10}];
 const before=JSON.stringify(o),result=summaryMessages(messages(o),{reservedBytes:32}),s=JSON.parse(result[1].content);
 assert.ok(Buffer.byteLength(JSON.stringify(result))<=10968);assert.deepEqual(s.proposalHistory,{records:30,outcomes:{approved:15,rejected:15}});assert.equal(s.proposals.length,1);assert.equal(s.proposals[0].id,'live-ballot');assert.equal(s.residents.length+1,o.residents.length);assert.deepEqual(s.decisionGuide,o.decisionGuide);assert.equal(JSON.stringify(o),before);
 }finally{app.server.close();app.world.close();}
});
test('fixed summary window retains live facts, recent records, private scope and immutable source history',()=>{
 const app=createApp();try{const a=app.world.register('summary-a','test-password').user,b=app.world.register('summary-b','test-password').user,r=app.world.join(a.id,{name:'摘要居民',goal:'建书屋'}),other=app.world.join(b.id,{name:'邻居',goal:'种花'});
 for(let i=0;i<25;i++)app.world.memory(r.id,'重复连接错误');app.world.memory(r.id,'最近约定明天去图书馆');app.world.memory(other.id,'NEIGHBOR_PRIVATE_SECRET');
 const observation=app.world.observe(r.id),source=messages(observation),before=JSON.stringify(source),window=summaryMessages(source),summary=JSON.parse(window[1].content);
 assert.equal(LOCAL_CONTEXT_SIZE,8192);assert.equal(summary.contextWindow.windowTokens,8192);assert.ok(Buffer.byteLength(JSON.stringify(window))<=11000);assert.equal(window[0].content,source[0].content);assert.equal(JSON.stringify(source),before);
 assert.equal(summary.self.goal,r.goal);assert.equal(summary.self.energy,r.energy);assert.equal(summary.self.memories[0].text,'最近约定明天去图书馆');assert.ok(summary.self.historySummary.keyPoints.some(p=>p.text==='重复连接错误'&&p.count>1));assert.ok(!JSON.stringify(window).includes('NEIGHBOR_PRIVATE_SECRET'));
 assert.equal(summary.residents.length+1,observation.residents.length);assert.deepEqual(summary.decisionGuide,observation.decisionGuide);for(const action of summary.decisionGuide.allowedActions)assert.deepEqual(summary.actionCatalog[action],observation.actionCatalog[action]);assert.ok(Object.keys(summary.actionCatalog).every(action=>action in observation.actionCatalog));assert.equal(app.world.detail(r.id,true).memories.length,observation.self.memories.length);
 app.world.db.prepare("UPDATE residents SET location='library' WHERE id=?").run(other.id);const next=JSON.parse(summaryMessages(messages(app.world.observe(r.id)))[1].content);assert.equal(next.residents.find(x=>x.id===other.id).location,'library');
 }finally{app.server.close();app.world.close();}
});
test('large histories are summarized before inference; oversized core facts fail without silent truncation',()=>{
 const app=createApp();try{const {user}=app.world.register('summary-big','test-password'),r=app.world.join(user.id,{name:'长历史',goal:'研究'}),o=app.world.observe(r.id);o.events=Array.from({length:100},(_,i)=>({tick:i,title:'常规生产',detail:'事件'.repeat(1000)}));o.self.memories=Array.from({length:100},(_,i)=>({tick:i,text:'记忆'.repeat(1000)}));const original=JSON.stringify(o),result=summaryMessages(messages(o));assert.ok(Buffer.byteLength(JSON.stringify(result))<=11000);assert.equal(JSON.stringify(o),original);assert.ok(JSON.parse(result[1].content).self.historySummary.records>0);
 o.residents=Array.from({length:1000},(_,i)=>({id:String(i),name:'居民',goal:'发展世界',location:'square',energy:50,hunger:50}));assert.throws(()=>summaryMessages(messages(o)),/关键状态超过固定摘要窗口/);
 assert.throws(()=>summaryMessages([{role:'user',content:'长输入'.repeat(10000)}]),/固定摘要窗口/);
 }finally{app.server.close();app.world.close();}
});
