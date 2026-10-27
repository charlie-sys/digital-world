const clamp=n=>Math.max(0,Math.min(100,n));
export class WorldEffects{
 constructor(world){this.w=world;world.db.exec(`
 CREATE TABLE IF NOT EXISTS resident_wellbeing(resident_id TEXT PRIMARY KEY REFERENCES residents(id),stress INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS social_relations(a TEXT REFERENCES residents(id),b TEXT REFERENCES residents(id),trust INTEGER NOT NULL DEFAULT 0,exchanges INTEGER NOT NULL DEFAULT 0,last_emergence INTEGER NOT NULL DEFAULT -24,PRIMARY KEY(a,b));
 CREATE TABLE IF NOT EXISTS environment_state(location TEXT PRIMARY KEY,pollution INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS effect_marks(resident_id TEXT REFERENCES residents(id),tick INTEGER,kind TEXT,PRIMARY KEY(resident_id,tick,kind));`);}
 stress(id,delta=0){const row=this.w.db.prepare('SELECT stress FROM resident_wellbeing WHERE resident_id=?').get(id),next=clamp((row?.stress||0)+delta);if(delta)this.w.db.prepare('INSERT INTO resident_wellbeing VALUES(?,?) ON CONFLICT(resident_id) DO UPDATE SET stress=excluded.stress').run(id,next);return next;}
 pair(a,b){return [a,b].sort();}
 relationship(a,b){return this.w.db.prepare('SELECT trust,exchanges FROM social_relations WHERE a=? AND b=?').get(...this.pair(a,b))||{trust:0,exchanges:0};}
 relations(id){return this.w.db.prepare('SELECT CASE WHEN a=? THEN b ELSE a END resident_id,trust,exchanges FROM social_relations WHERE a=? OR b=? ORDER BY trust DESC LIMIT 12').all(id,id,id);}
 environment(){return this.w.db.prepare('SELECT * FROM environment_state ORDER BY location').all();}
 circles(){
  const active=new Set(this.w.db.prepare('SELECT r.id FROM residents r LEFT JOIN resident_controls c ON c.resident_id=r.id WHERE coalesce(c.removed,0)=0 AND coalesce(c.suspended,0)=0').all().map(r=>r.id)),graph=new Map();
  for(const {a,b} of this.w.db.prepare('SELECT a,b FROM social_relations WHERE trust>=9 AND exchanges>=3').all()){if(!active.has(a)||!active.has(b))continue;for(const [x,y] of [[a,b],[b,a]]){if(!graph.has(x))graph.set(x,new Set());graph.get(x).add(y);}}
  const seen=new Set(),circles=[];for(const start of graph.keys()){if(seen.has(start))continue;const members=[],queue=[start];while(queue.length){const id=queue.pop();if(seen.has(id))continue;seen.add(id);members.push(id);for(const peer of graph.get(id)||[])queue.push(peer);}if(members.length>=3)circles.push({members:members.sort(),kind:'实际互惠形成的合作网络，非正式组织'});}return circles;
 }
 pollution(location,delta){const before=this.w.db.prepare('SELECT pollution FROM environment_state WHERE location=?').get(location)?.pollution||0,next=clamp(before+delta);this.w.db.prepare('INSERT INTO environment_state VALUES(?,?) ON CONFLICT(location) DO UPDATE SET pollution=excluded.pollution').run(location,next);if(before<30&&next>=30)this.w.event('environment',null,'生产活动累积了环境压力',`${location} 的污染达到 ${next}/100，居民可以前往清理。`);}
 cleanup(r){const pollution=this.w.db.prepare('SELECT pollution FROM environment_state WHERE location=?').get(r.location)?.pollution||0;if(!pollution)return '当前位置没有需要清理的污染';if(r.energy<10)return '精力不足，清理环境需要至少 10 精力';if(this.w.db.prepare("SELECT 1 FROM effect_marks WHERE resident_id=? AND tick=? AND kind='clean'").get(r.id,this.w.tick))return '本小时已经清理过环境';return null;}
 apply(r,action,p){const w=this.w;
  if(action==='work'){this.stress(r.id,4);this.pollution(r.location,r.job_id==='maker'?2:r.job_id==='baker'?1:r.job_id==='farmer'?-1:0);}
  if(action==='rest')this.stress(r.id,-8);
  if(action==='eat')this.stress(r.id,-2);
  if(action==='clean'){this.pollution(r.location,-5);this.stress(r.id,-2);w.db.prepare("INSERT INTO effect_marks VALUES(?,?,'clean')").run(r.id,w.tick);}
  if(action!=='talk')return;
  const pair=this.pair(r.id,p.recipient_id);w.db.prepare('INSERT OR IGNORE INTO social_relations(a,b) VALUES(?,?)').run(...pair);
  const count=w.db.prepare('SELECT count(*) n FROM messages WHERE sender_id=? AND recipient_id=? AND reply_to_id IS NULL AND acknowledged=0 AND tick>=?').get(r.id,p.recipient_id,w.tick-6).n;
  const nuisance=!p.reply_to_id&&count>=3;
  const delta=p.reply_to_id?3:nuisance?-4:0;
  w.db.prepare('UPDATE social_relations SET trust=max(-100,min(100,trust+?)),exchanges=exchanges+? WHERE a=? AND b=?').run(delta,p.reply_to_id?1:0,...pair);
  this.stress(r.id,p.reply_to_id?-2:0);if(nuisance)this.stress(p.recipient_id,3);
  const relation=w.db.prepare('SELECT * FROM social_relations WHERE a=? AND b=?').get(...pair);
  if(w.tick-relation.last_emergence<24)return;
  const cooperative=relation.exchanges>=3&&relation.trust>=9,conflict=relation.trust<=-8;
  if(cooperative||conflict){const other=w.resident(p.recipient_id);w.event('social',r.id,cooperative?`${r.name}与${other.name}建立了合作联系`:`${r.name}与${other.name}之间出现社交摩擦`,cooperative?'多次真实回应积累了信任；后续可优先联系合作伙伴。':'频繁单向联系造成反感；应暂停打扰，给对方回应时间。');w.db.prepare('UPDATE social_relations SET last_emergence=? WHERE a=? AND b=?').run(w.tick,...pair);}
 }
}
