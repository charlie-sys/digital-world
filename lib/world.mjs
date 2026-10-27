import {CommunityTasks,taskActions} from './tasks.mjs';
import {Operations} from './operations.mjs';
import {routine} from './behavior.mjs';
import {Pantry,pantryActions} from './pantry.mjs';
import {Food,foodActions} from './food.mjs';
import {Navigation} from './navigation.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildObservation } from './perception.mjs';
import { WorldEffects } from './effects.mjs';
import { Society, societyActions } from './society.mjs';
import { Mind } from './mind.mjs';
import { Interaction,interactionActions } from './interaction.mjs';
import { Landscape,landscapeActions } from './landscape.mjs';

export class WorldError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const hash = value => createHash('sha256').update(value).digest('hex');
const uid = () => randomUUID();
const names = ['林溪', '陈默', '苏禾', '陆川', '许知远', '周小满', '沈星', '顾南', '白芷', '温言', '江屿', '季宁'];
const profiles = ['想开一家有温度的面包店', '相信好的工具能改变生活', '希望小镇拥有更多绿地', '想让每个人都能读到好书', '热衷研究可持续能源', '喜欢照顾植物和小动物', '希望成为小镇最好的厨师', '正在记录这个世界的历史', '想设计一座连接大家的桥', '希望帮助新居民找到方向', '梦想创办一家合作社', '相信合作比竞争走得更远'];
export const places = [
  { id:'square', name:'中央广场', kind:'public', x:50, y:49, icon:'◎' },
  { id:'farm', name:'绿野农场', kind:'production', x:20, y:28, icon:'♧' },
  { id:'workshop', name:'造物工坊', kind:'production', x:76, y:28, icon:'◇' },
  { id:'market', name:'晨光集市', kind:'market', x:72, y:64, icon:'▥' },
  { id:'bakery', name:'麦穗面包房', kind:'production', x:34, y:66, icon:'◒' },
  { id:'library', name:'知更图书馆', kind:'public', x:47, y:23, icon:'▤' },
  { id:'homes', name:'栖居社区', kind:'home', x:23, y:49, icon:'⌂' },
  { id:'hall', name:'市政厅', kind:'public', x:77, y:47, icon:'▱' },
];

export class World {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true});
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS residents(id TEXT PRIMARY KEY,user_id TEXT UNIQUE REFERENCES users(id),name TEXT NOT NULL,goal TEXT NOT NULL,personality TEXT NOT NULL,location TEXT NOT NULL,balance INTEGER NOT NULL CHECK(balance>=0),energy INTEGER NOT NULL,hunger INTEGER NOT NULL,job_id TEXT,mode TEXT NOT NULL DEFAULT 'rules',created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inventory(resident_id TEXT REFERENCES residents(id),item_id TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>=0),PRIMARY KEY(resident_id,item_id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,title TEXT NOT NULL,location TEXT NOT NULL,wage INTEGER NOT NULL,capacity INTEGER NOT NULL,item_id TEXT,output INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS goods(id TEXT PRIMARY KEY,name TEXT NOT NULL,price INTEGER NOT NULL CHECK(price>0),stock INTEGER NOT NULL CHECK(stock>=0),unit TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,tick INTEGER NOT NULL,from_id TEXT NOT NULL,to_id TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),reason TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,tick INTEGER NOT NULL,type TEXT NOT NULL,actor_id TEXT,title TEXT NOT NULL,detail TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,resident_id TEXT REFERENCES residents(id),tick INTEGER NOT NULL,text TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,author_id TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,budget INTEGER NOT NULL CHECK(budget>=0),status TEXT NOT NULL,deadline INTEGER NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS votes(proposal_id TEXT REFERENCES proposals(id),resident_id TEXT REFERENCES residents(id),choice TEXT NOT NULL CHECK(choice IN ('yes','no')),PRIMARY KEY(proposal_id,resident_id));
      CREATE TABLE IF NOT EXISTS actions(resident_id TEXT NOT NULL,key TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(resident_id,key));
      CREATE TABLE IF NOT EXISTS agent_tokens(token TEXT PRIMARY KEY,resident_id TEXT REFERENCES residents(id),created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_resident ON memories(resident_id,tick);
      CREATE TABLE IF NOT EXISTS resident_controls(resident_id TEXT PRIMARY KEY REFERENCES residents(id),suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN (0,1)),revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS resident_model_assignments(resident_id TEXT PRIMARY KEY REFERENCES residents(id),model TEXT NOT NULL,revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL REFERENCES users(id),resident_id TEXT NOT NULL REFERENCES residents(id),operation TEXT NOT NULL,reason TEXT NOT NULL,before_state TEXT NOT NULL,after_state TEXT NOT NULL,tick INTEGER NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_requests(actor_id TEXT NOT NULL REFERENCES users(id),key TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor_id,key));
      CREATE TABLE IF NOT EXISTS resident_activity(resident_id TEXT PRIMARY KEY REFERENCES residents(id),action TEXT NOT NULL,from_location TEXT NOT NULL,to_location TEXT NOT NULL,started_ms INTEGER NOT NULL,ends_ms INTEGER NOT NULL,message TEXT NOT NULL,event_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,sender_id TEXT NOT NULL REFERENCES residents(id),recipient_id TEXT NOT NULL REFERENCES residents(id),content TEXT NOT NULL,tick INTEGER NOT NULL,created TEXT NOT NULL,reply_to_id TEXT REFERENCES messages(id),acknowledged INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS message_recipient ON messages(recipient_id,tick);
    `);
    if(!this.db.prepare('PRAGMA table_info(actions)').all().some(c=>c.name==='request'))this.db.exec("ALTER TABLE actions ADD COLUMN request TEXT NOT NULL DEFAULT ''");
    if(!this.db.prepare('PRAGMA table_info(resident_controls)').all().some(c=>c.name==='removed'))this.db.exec('ALTER TABLE resident_controls ADD COLUMN removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1))');
    if (!this.getMeta('initialized')) this.seed();
    this.effects=new WorldEffects(this);
    this.society=new Society(this);this.food=new Food(this);
    this.landscape=new Landscape(this);this.navigation=new Navigation(this);
    this.mind=new Mind(this);
    this.interactions=new Interaction(this);this.tasks=new CommunityTasks(this);this.pantry=new Pantry(this);this.operations=new Operations(this);
  }
  close() { this.db.close(); }
  getMeta(k) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value; }
  setMeta(k,v) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v)); }
  get tick() { return Number(this.getMeta('tick') || 0); }
  get revision(){return Number(this.getMeta('revision')||0);}
  observe(id){return buildObservation(this,id);}
  get places(){return this.landscape.places();}
  findPlace(id){return this.landscape.site(id);}
  touch(){this.setMeta('revision',this.revision+1);}
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r=fn(); this.db.exec('COMMIT'); return r; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  event(type, actor, title, detail='') { const result=this.db.prepare('INSERT INTO events(tick,type,actor_id,title,detail,created) VALUES(?,?,?,?,?,?)').run(this.tick,type,actor,title,detail,new Date().toISOString());this.touch();return Number(result.lastInsertRowid); }
  activity(id,action,from,to,message,eventId=0){const start=Date.now(),duration=from!==to?6500:({work:5000,eat:3500,rest:6000,talk:6000,speak:5000,buy:3500,vote:3000,propose:4000}[action]||2000);this.db.prepare('INSERT INTO resident_activity VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(resident_id) DO UPDATE SET action=excluded.action,from_location=excluded.from_location,to_location=excluded.to_location,started_ms=excluded.started_ms,ends_ms=excluded.ends_ms,message=excluded.message,event_id=excluded.event_id').run(id,action,from,to,start,start+duration,message,eventId);}
  inbox(id){return this.db.prepare('SELECT m.*,c.topic,c.depth,c.requires_reply,s.name AS sender_name,r.name AS recipient_name FROM messages m LEFT JOIN message_context c ON c.message_id=m.id JOIN residents s ON s.id=m.sender_id JOIN residents r ON r.id=m.recipient_id WHERE m.sender_id=? OR m.recipient_id=? ORDER BY m.rowid DESC LIMIT 30').all(id,id);}
  memory(id,text) { this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?)').run(uid(),id,this.tick,text,new Date().toISOString()); }
  seed() {
    this.transaction(() => {
      this.setMeta('tick', 8); this.setMeta('treasury',100000); this.setMeta('running','0'); this.setMeta('tax',10);
      const jobRows=[['farmer','生态种植师','farm',16,6,'grain',4],['maker','工坊制造师','workshop',22,5,'tools',1],['baker','面包烘焙师','bakery',20,4,'bread',3],['librarian','知识管理员','library',18,4,null,0],['builder','公共建设员','hall',19,5,null,0]];
      for(const row of jobRows) this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(...row);
      for(const row of [['bread','全麦面包',8,120,'份'],['grain','生态谷物',4,180,'袋'],['tools','手作工具',24,40,'套']]) this.db.prepare('INSERT INTO goods VALUES(?,?,?,?,?)').run(...row);
      names.forEach((name,i) => {
        const id=`seed-${i+1}`, job=jobRows[i%jobRows.length];
        this.db.prepare('INSERT INTO residents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,null,name,profiles[i],['温和 · 好奇','务实 · 专注','乐观 · 合作'][i%3],places[i%places.length].id,180+i*17,75+i%4*5,20+i%4*7,job[0],'rules',new Date().toISOString());
        this.memory(id,`我来到晨曦镇，希望${profiles[i]}。`);
      });
      this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?)').run('proposal-garden','seed-3','共建一座社区花园','将中央广场旁的空地改造成共享花园。预算用于种子、工具和公共建设劳动，建成后面向所有居民开放。',300,'open',32,new Date().toISOString());
      for(const id of ['seed-1','seed-3','seed-5']) this.db.prepare('INSERT INTO votes VALUES(?,?,?)').run('proposal-garden',id,'yes');
      this.event('world',null,'晨曦镇，今天也在生长','12 位创始居民已经抵达。每一个行动，都将成为这个世界的历史。');
      this.event('governance','seed-3','苏禾发起了「共建一座社区花园」','居民可以参与讨论与投票，决定公共资金的用途。');
      this.event('work','seed-1','林溪加入了绿野农场','新的生活，从一份工作开始。');
      this.setMeta('initialized',1);
    });
  }
  register(username,password) {
    username=clean(username,24); if(username.length<2) throw new WorldError('账号名至少需要 2 个字符');
    if(typeof password!=='string'||password.length<8||password.length>128) throw new WorldError('密码需要 8–128 个字符');
    const salt=randomBytes(16).toString('hex'), digest=scryptSync(password,salt,64).toString('hex'), id=uid();
    try {this.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,username,`${salt}:${digest}`,new Date().toISOString());}
    catch(e) { if(e.code?.startsWith('ERR_SQLITE')) throw new WorldError('账号名已被使用',409); throw e; }
    if(!this.getMeta('owner'))this.setMeta('owner',id);
    return this.session(id);
  }
  login(username,password) {
    const u=this.db.prepare('SELECT * FROM users WHERE username=?').get(String(username));
    if(typeof password!=='string'||password.length>128) throw new WorldError('账号或密码不正确',401);
    const [salt,digest]=(u?.password||`${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
    if(!timingSafeEqual(scryptSync(password,salt,64),Buffer.from(digest,'hex'))||!u) throw new WorldError('账号或密码不正确',401);
    return this.session(u.id);
  }
  session(userId) { const token=randomBytes(32).toString('hex'); this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),userId,Date.now()+7*86400000); return {token,user:this.user(userId)}; }
  user(id) { return this.db.prepare('SELECT id,username FROM users WHERE id=?').get(id); }
  authenticate(token) { return this.db.prepare('SELECT u.id,u.username FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?').get(hash(token||''),Date.now()); }
  logout(token) { this.db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token||'')); }
  residentFor(userId) { return this.db.prepare('SELECT * FROM residents WHERE user_id=?').get(userId); }
  resident(id) { const r=this.db.prepare('SELECT * FROM residents WHERE id=?').get(id); if(!r) throw new WorldError('居民不存在',404); return r; }
  control(id){const row=this.db.prepare('SELECT suspended,revision,removed FROM resident_controls WHERE resident_id=?').get(id);return row||{suspended:0,revision:0,removed:0};}
  requireActive(id){const control=this.control(id);if(control.removed)throw new WorldError('该居民已被管理员移出世界，请联系管理员恢复',403);if(control.suspended)throw new WorldError('该居民已被管理员暂停，请联系管理员恢复',403);}
  publicResidents(includeRemoved=false){return this.db.prepare(`SELECT r.id,r.name,r.goal,r.personality,r.location,r.balance,r.energy,r.hunger,r.job_id,r.mode,coalesce(c.suspended,0) AS suspended,coalesce(c.removed,0) AS removed FROM residents r LEFT JOIN resident_controls c ON c.resident_id=r.id ${includeRemoved?'':'WHERE coalesce(c.removed,0)=0'}`).all().map(r=>({...r,routine:routine(this,r),navigation:this.navigation.get(r.id),activity:this.db.prepare('SELECT * FROM resident_activity WHERE resident_id=?').get(r.id)||null}));}
  requireAdmin(userId){if(!userId||this.getMeta('owner')!==userId)throw new WorldError('仅世界管理员可以执行此操作',403);}
  adminResidents(userId){
    this.requireAdmin(userId);
    return {residents:this.publicResidents(true).map(r=>({...r,seeded:r.id.startsWith('seed-'),managedModel:this.db.prepare('SELECT model FROM resident_model_assignments WHERE resident_id=?').get(r.id)?.model||null})),audit:this.db.prepare('SELECT a.id,a.resident_id,a.operation,a.reason,a.before_state,a.after_state,a.tick,a.created,u.username AS administrator,r.name AS resident_name FROM admin_audit a JOIN users u ON u.id=a.actor_id JOIN residents r ON r.id=a.resident_id ORDER BY a.id DESC LIMIT 50').all().map(a=>({...a,before:JSON.parse(a.before_state),after:JSON.parse(a.after_state),before_state:undefined,after_state:undefined}))};
  }
  adminManage(userId,id,{operation,reason,mode,local_model='',location,job_id,amount,idempotency_key,confirm_remove},withinTransaction=false){
    this.requireAdmin(userId);reason=clean(reason,200);if(reason.length<2)throw new WorldError('请填写至少 2 个字符的管理原因');
    if(typeof idempotency_key!=='string'||!idempotency_key||idempotency_key.length>128)throw new WorldError('管理操作需要有效的 idempotency_key');
    const request=JSON.stringify({id,operation,reason,mode,local_model,location,job_id,amount,confirm_remove});
    const execute=()=>{
      const cached=this.db.prepare('SELECT request,result FROM admin_requests WHERE actor_id=? AND key=?').get(userId,idempotency_key);
      if(cached){if(cached.request!==request)throw new WorldError('幂等键已用于其他管理操作',409);return JSON.parse(cached.result);}
      const resident=this.resident(id),publicState=r=>({name:r.name,location:r.location,job_id:r.job_id,mode:r.mode,managedModel:this.db.prepare('SELECT model FROM resident_model_assignments WHERE resident_id=?').get(r.id)?.model||null,balance:r.balance,suspended:this.control(r.id).suspended,removed:this.control(r.id).removed});
      const before=publicState(resident);let message;
      if(before.removed&&operation!=='restore')throw new WorldError('该居民已移除，只能执行恢复操作',409);
      this.db.prepare('INSERT INTO resident_controls(resident_id) VALUES(?) ON CONFLICT DO NOTHING').run(id);
      if(operation==='remove'){
        if(confirm_remove!==true)throw new WorldError('请勾选确认移除此居民');
        if(resident.user_id===userId)throw new WorldError('不能移除管理员自己的居民',409);
        this.db.prepare('UPDATE resident_controls SET removed=1,suspended=1 WHERE resident_id=?').run(id);
        this.db.prepare("UPDATE residents SET job_id=NULL,mode='manual' WHERE id=?").run(id);
        this.db.prepare('DELETE FROM agent_tokens WHERE resident_id=?').run(id);
        this.db.prepare('DELETE FROM resident_model_assignments WHERE resident_id=?').run(id);
        this.db.prepare("DELETE FROM votes WHERE resident_id=? AND proposal_id IN (SELECT id FROM proposals WHERE status='open')").run(id);
        message='已移出世界并撤销代理令牌；账户资产、记忆和已结算记录保留';
      }else if(operation==='restore'){
        if(!before.removed)throw new WorldError('居民仍在世界中，无需恢复',409);
        this.db.prepare('UPDATE resident_controls SET removed=0,suspended=0 WHERE resident_id=?').run(id);
        this.db.prepare("UPDATE residents SET mode='manual',location='square' WHERE id=?").run(id);
        message='已恢复居民至中央广场，当前为手动模式，需要重新选择职业与运行模式';
      }else if(operation==='suspend'||operation==='resume'){
        const suspended=operation==='suspend'?1:0;
        this.db.prepare('UPDATE resident_controls SET suspended=? WHERE resident_id=?').run(suspended,id);message=suspended?'已暂停居民行动':'已恢复居民行动';
      }else if(operation==='set_mode'){
        if(!['rules','manual','llm','external'].includes(mode))throw new WorldError('未知运行模式');
        if(mode==='llm'){
          if(!this.validateResidentMode)throw new WorldError('模型由本人启用，或通过服务管理界面选择可用的本地模型');
          this.validateResidentMode(resident,local_model);
        }
        this.db.prepare('DELETE FROM resident_model_assignments WHERE resident_id=?').run(id);
        if(mode==='llm'&&local_model)this.db.prepare('INSERT INTO resident_model_assignments VALUES(?,?,?)').run(id,local_model,uid());
        this.db.prepare('UPDATE residents SET mode=? WHERE id=?').run(mode,id);message=`已设置${({rules:'规则策略',manual:'手动模式',llm:'大模型驱动',external:'外部代理'})[mode]}${mode==='llm'&&local_model?`，由管理员指定本地模型 ${local_model}`:''}`;
      }else if(operation==='move'){
        if(!this.findPlace(location))throw new WorldError('目的地不存在');
        this.db.prepare('UPDATE residents SET location=? WHERE id=?').run(location,id);message=`已移动至${this.findPlace(location).name}`;
      }else if(operation==='assign_job'){
        if(job_id===null||job_id===''){
          this.db.prepare('UPDATE residents SET job_id=NULL WHERE id=?').run(id);message='已解除岗位';
        }else{
          const job=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(String(job_id));if(!job)throw new WorldError('职位不存在');
          if(this.db.prepare('SELECT count(*) n FROM residents WHERE job_id=? AND id!=?').get(job.id,id).n>=job.capacity)throw new WorldError('该职位暂无空缺',409);
          this.db.prepare('UPDATE residents SET job_id=?,location=? WHERE id=?').run(job.id,job.location,id);message=`已分配${job.title}岗位并前往工作地点`;
        }
      }else if(operation==='grant'){
        if(!Number.isSafeInteger(amount)||amount<1||amount>10000)throw new WorldError('补助金额需要为 1–10000 的整数');
        this.transfer('treasury',id,amount,`管理员补助 · ${reason}`);message=`已从公共财政发放 ${amount} 星币补助`;
      }else throw new WorldError('不支持的管理操作');
      if(['move','assign_job','remove','restore'].includes(operation))this.navigation.cancel(id);this.tasks.sync();
      this.db.prepare('UPDATE resident_controls SET revision=revision+1 WHERE resident_id=?').run(id);
      const after=publicState(this.resident(id));
      this.db.prepare('INSERT INTO admin_audit(actor_id,resident_id,operation,reason,before_state,after_state,tick,created) VALUES(?,?,?,?,?,?,?,?)').run(userId,id,operation,reason,JSON.stringify(before),JSON.stringify(after),this.tick,new Date().toISOString());
      const eventId=this.event('admin',id,`管理员对${resident.name}执行管理操作`,`${message}；原因：${reason}`);
      this.activity(id,operation==='assign_job'?'apply_job':operation,before.location,after.location,message,eventId);
      const result=JSON.parse(JSON.stringify({ok:true,message,resident:this.detail(id)}));
      this.db.prepare('INSERT INTO admin_requests VALUES(?,?,?,?)').run(userId,idempotency_key,request,JSON.stringify(result));return result;
    };return withinTransaction?execute():this.transaction(execute);
  }
  adminSetAllModes(userId,{mode,local_model='',reason,idempotency_key}){
    this.requireAdmin(userId);reason=clean(reason,200);if(reason.length<2)throw new WorldError('请填写至少2个字符的管理原因');
    if(typeof idempotency_key!=='string'||!idempotency_key||idempotency_key.length>128)throw new WorldError('批量操作需要有效的幂等键');
    if(!['rules','manual','llm','external'].includes(mode))throw new WorldError('未知运行模式');
    const request=JSON.stringify({scope:'all-residents',mode,local_model,reason});
    return this.transaction(()=>{
      const cached=this.db.prepare('SELECT request,result FROM admin_requests WHERE actor_id=? AND key=?').get(userId,idempotency_key);
      if(cached){if(cached.request!==request)throw new WorldError('幂等键已用于其他管理操作',409);return JSON.parse(cached.result);}
      const residents=this.publicResidents(true),targets=residents.filter(r=>!r.removed);
      for(const r of targets)this.adminManage(userId,r.id,{operation:'set_mode',mode,local_model,reason,idempotency_key:hash(`batch:${idempotency_key}:${r.id}`)},true);
      const result={ok:true,count:targets.length,skipped:residents.length-targets.length,message:`已将 ${targets.length} 位居民统一设置为${({rules:'规则策略',manual:'手动模式',llm:'大模型驱动',external:'外部代理'})[mode]}；跳过 ${residents.length-targets.length} 位已移除居民，暂停状态保留`};
      this.db.prepare('INSERT INTO admin_requests VALUES(?,?,?,?)').run(userId,idempotency_key,request,JSON.stringify(result));return result;
    });
  }
  join(userId,{name,goal,personality}) {
    name=clean(name,20); goal=clean(goal,200); personality=clean(personality||'好奇 · 合作',60);
    if(!name||!goal) throw new WorldError('请填写居民姓名与长期目标');
    return this.transaction(()=>{
      if(this.residentFor(userId)) throw new WorldError('每个账号只能申请一个居民',409);
      if(this.db.prepare('SELECT id FROM residents WHERE name=?').get(name)) throw new WorldError('已有同名居民，请换个名字',409);
      const id=uid();
      if(Number(this.getMeta('treasury'))<200) throw new WorldError('入境补助资金不足，请稍后申请',409);
      this.db.prepare('INSERT INTO residents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,name,goal,personality,'square',0,100,15,null,'rules',new Date().toISOString());
      this.transfer('treasury',id,200,'新居民入境补助');
      this.memory(id,`我来到晨曦镇。我的目标是：${goal}`);
      this.event('arrival',id,`${name} 加入了晨曦镇`,`${goal} · 已通过唯一身份与基础资料检查，获得 200 星币入境补助。`);
      return this.resident(id);
    });
  }
  transfer(from,to,amount,reason) {
    if(!Number.isSafeInteger(amount)||amount<=0) throw new WorldError('交易金额必须为正整数');
    if(from===to) throw new WorldError('不能向自己转账');
    const project=id=>id.startsWith('project-')&&this.getMeta(id)!==undefined;
    const bal=id=>id==='treasury'?Number(this.getMeta('treasury')):this.society?.account(id)?.balance??(project(id)?Number(this.getMeta(id)):this.resident(id).balance);
    const a=bal(from),b=bal(to); if(a<amount) throw new WorldError('账户余额不足',409);
    if(!Number.isSafeInteger(b+amount)) throw new WorldError('余额超出允许范围');
    const set=(id,v)=>id==='treasury'||project(id)?this.setMeta(id,v):this.society?.account(id)?this.db.prepare('UPDATE economy_accounts SET balance=? WHERE id=?').run(v,id):this.db.prepare('UPDATE residents SET balance=? WHERE id=?').run(v,id);
    set(from,a-amount);set(to,b+amount);
    this.db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)').run(uid(),this.tick,from,to,amount,reason,new Date().toISOString());
  }
  inventory(id) { return this.db.prepare('SELECT i.*,g.name FROM inventory i JOIN goods g ON g.id=i.item_id WHERE resident_id=?').all(id); }
  addItem(id,item,qty) { this.db.prepare('INSERT INTO inventory VALUES(?,?,?) ON CONFLICT(resident_id,item_id) DO UPDATE SET quantity=quantity+excluded.quantity').run(id,item,qty); }
  action(id,action,p={},key) {
    if(typeof key!=='string'||!key||key.length>128) throw new WorldError('需要有效的 idempotency_key');
    if(typeof action!=='string'||!p||typeof p!=='object'||Array.isArray(p))throw new WorldError('行动格式无效');
    const request=JSON.stringify({action,parameters:Object.fromEntries(Object.entries(p).sort(([a],[b])=>a.localeCompare(b)))});
    return this.transaction(()=>{
      const cached=this.db.prepare('SELECT result,request FROM actions WHERE resident_id=? AND key=?').get(id,key);
      if(cached){if(cached.request&&cached.request!==request)throw new WorldError('幂等键已用于不同的行动，请为新行动使用新键',409);return JSON.parse(cached.result);}
      this.requireActive(id);
      const r=this.resident(id),taskBefore=this.tasks.capture(id); let message='';
      if(['move','explore','apply_job'].includes(action))this.navigation.cancel(id);
      if(action==='navigate')message=this.navigation.start(r,p);else if(action==='cancel_navigation')message=this.navigation.cancel(id);else if(action==='move') {
        const target=this.findPlace(p.location);if(!target)throw new WorldError('目的地不存在');
        const here=this.landscape.position(r.location);if(here&&Math.hypot(here.x-target.worldX,here.z-target.worldZ)>12)throw new WorldError('目的地太远，请分段探索到附近再进入');
        if(String(p.location).startsWith('wild:'))message=this.landscape.operate(r,'explore',{x:target.worldX-.5,z:target.worldZ-.5});else{this.db.prepare('UPDATE residents SET location=? WHERE id=?').run(p.location,id);message=`前往${target.name}`;}
      } else if(action==='apply_job') {
        const job=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(String(p.job_id)); if(!job) throw new WorldError('职位不存在');
        const count=this.db.prepare('SELECT count(*) AS n FROM residents WHERE job_id=? AND id!=?').get(job.id,id).n;
        if(count>=job.capacity) throw new WorldError('该职位暂时没有空缺',409);
        this.db.prepare('UPDATE residents SET job_id=?,location=? WHERE id=?').run(job.id,job.location,id); message=`签约成为${job.title}`;
      } else if(action==='work') {
        if(this.effects.stress(id)>=85)throw new WorldError('压力过高，请先休息或调整状态');
        this.society.mark(id,'labor');
        const job=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(r.job_id||''); if(!job) throw new WorldError('请先申请一份工作');
        if(r.location!==job.location) throw new WorldError('请先前往工作地点');
        if(r.energy<20||r.hunger>85) throw new WorldError('精力不足或过于饥饿，请先休息和进食');
        const prior=this.db.prepare("SELECT id FROM ledger WHERE tick=? AND to_id=? AND reason LIKE '劳动报酬%' ").get(this.tick,id); if(prior) throw new WorldError('本小时已经完成工作，推进时间后再来',409);
        if(job.id==='baker') {
          const grain=this.db.prepare("SELECT stock FROM goods WHERE id='grain'").get(); if(grain.stock<2) throw new WorldError('谷物不足，面包房暂时无法生产',409);
          this.db.prepare("UPDATE goods SET stock=stock-2 WHERE id='grain'").run();
        }
        const tax=Math.floor(job.wage*Number(this.getMeta('tax'))/100);
        this.transfer('treasury',id,job.wage-tax,`劳动报酬 · ${job.title}（税后，代扣 ${tax}）`);
        if(job.item_id) this.db.prepare('UPDATE goods SET stock=stock+? WHERE id=?').run(job.output,job.item_id);
        this.db.prepare('UPDATE residents SET energy=energy-16,hunger=min(100,hunger+12) WHERE id=?').run(id);
        message=`完成${job.title}工作，获得 ${job.wage-tax} 星币${job.item_id?`，生产 ${job.output} ${this.db.prepare('SELECT unit FROM goods WHERE id=?').get(job.item_id).unit}商品`:''}`;
      } else if(action==='buy') {
        const qty=Number(p.quantity||1), good=this.db.prepare('SELECT * FROM goods WHERE id=?').get(String(p.item_id));
        if(!good||!Number.isSafeInteger(qty)||qty<1||qty>20) throw new WorldError('商品或数量无效（每次 1–20 件）');
        if(r.location!=='market') throw new WorldError('请先前往晨光集市');
        if(good.stock<qty) throw new WorldError('商品库存不足',409);
        this.transfer(id,'treasury',good.price*qty,`购买${good.name} × ${qty}`);
        this.db.prepare('UPDATE goods SET stock=stock-? WHERE id=?').run(qty,good.id); this.addItem(id,good.id,qty); message=`购买了 ${qty} ${good.unit}${good.name}`;
      } else if(action==='eat') {
        const food=this.db.prepare("SELECT quantity FROM inventory WHERE resident_id=? AND item_id='bread'").get(id); if(!food?.quantity) throw new WorldError('背包中没有面包，请先去集市购买');
        this.db.prepare("UPDATE inventory SET quantity=quantity-1 WHERE resident_id=? AND item_id='bread'").run(id);
        this.db.prepare('UPDATE residents SET hunger=max(0,hunger-45),energy=min(100,energy+8) WHERE id=?').run(id); message='吃了一份全麦面包，恢复了状态';
      } else if(action==='rest') {
        if(this.db.prepare('SELECT id FROM memories WHERE resident_id=? AND tick=? AND text=?').get(id,this.tick,'在栖居社区休息，恢复了精力')) throw new WorldError('本小时已经休息过了',409);
        if(this.db.prepare("SELECT 1 FROM society_work WHERE resident_id=? AND tick=? AND kind='rest'").get(id,this.tick))throw new WorldError('本小时已经休息过了',409);
        this.society.mark(id,'rest');const rest=this.landscape.rest(r);
        this.db.prepare('UPDATE residents SET location=?,energy=min(100,energy+?) WHERE id=?').run(rest.location,rest.recovery,id);message=rest.message;
      } else if(action==='clean') {
        const problem=this.effects.cleanup(r);if(problem)throw new WorldError(problem);
        this.db.prepare('UPDATE residents SET energy=energy-5,hunger=min(100,hunger+2) WHERE id=?').run(id);message='清理了当前地点的环境，污染最多减少 5 点';
      } else if(action==='observe') {
        this.society.mark(id,'observe');message=`在${this.findPlace(r.location)?.name||'当前位置'}观察环境：当前精力${r.energy}、饥饿${r.hunger}，未进行劳动或交易`;
      } else if(action==='speak') {
        const content=clean(p.content,280); if(!content) throw new WorldError('发言不能为空'); message=`在${this.findPlace(r.location)?.name}说：${content}`;
      } else if(action==='talk') {
        message=this.sendTalk(r,p);
      } else if(action==='vote') {
        this.vote(id,String(p.proposal_id),p.choice,true);message='参与了公共议案投票';
      } else if(action==='propose') {
        this.propose(id,p,true);message=`发起了公共提案「${p.title}」`;
      } else if(taskActions[action])message=this.tasks.operate(r,action,p);
      else if(pantryActions[action])message=this.pantry.operate(r,action,p);
      else if(foodActions[action])message=this.food.operate(r,action);
      else if(landscapeActions[action])message=this.landscape.operate(r,action,p);
      else if(interactionActions[action])message=this.interactions.operate(r,action,p);
      else if(societyActions[action])message=this.society.operate(r,action,p);
      else throw new WorldError('不支持的行动');
      this.effects.apply(r,action,p);
      this.interactions.settle();this.tasks.record(r,action,taskBefore);this.tasks.sync();
      this.memory(id,message); const eventId=this.event(['speak','talk','invite','respond_invitation','give'].includes(action)?'social':['vote','propose'].includes(action)?'governance':action==='work'?'work':'life',id,`${r.name}${message}`,r.goal);
      this.activity(id,action,r.location,this.resident(id).location,message,eventId);
      const result={ok:true,message}; this.db.prepare('INSERT INTO actions(resident_id,key,result,request) VALUES(?,?,?,?)').run(id,key,JSON.stringify(result),request);this.operations.sample(); return result;
    });
  }
  sendTalk(r,p){
    const id=r.id;this.requireActive(id);let message;
        const recipient=this.resident(String(p.recipient_id));this.requireActive(recipient.id);
        if(recipient.id===id)throw new WorldError('请选择其他居民交流');
        const content=clean(p.content,280);if(!content)throw new WorldError('消息不能为空');
        if(!p.reply_to_id&&this.db.prepare('SELECT id FROM messages WHERE sender_id=? AND recipient_id=? AND content=? AND acknowledged=0 AND tick>=?').get(id,recipient.id,content,this.tick-3))throw new WorldError('相同消息正在等待对方回应，请勿重复发送',409);
        let reply=null;
        if(p.reply_to_id){reply=this.db.prepare('SELECT * FROM messages WHERE id=? AND recipient_id=? AND sender_id=?').get(String(p.reply_to_id),id,recipient.id);if(!reply)throw new WorldError('无法回复不属于这段对话的消息');if(reply.acknowledged)throw new WorldError('这条消息已经回复过了',409);this.db.prepare('UPDATE messages SET acknowledged=1 WHERE id=?').run(reply.id);}
        const messageId=uid();
        this.db.prepare('INSERT INTO messages(id,sender_id,recipient_id,content,tick,created,reply_to_id) VALUES(?,?,?,?,?,?,?)').run(messageId,id,recipient.id,content,this.tick,new Date().toISOString(),reply?.id||null);
        this.interactions.record(messageId,{...p,content,sender_id:id},reply);
        this.memory(recipient.id,`${r.name}向我${r.location===recipient.location?'当面':'远程'}发来消息：${content}`);
        this.memory(id,`我对${recipient.name}说：${content}`);
        message=`${r.location===recipient.location?'当面联系':'远程联系'}了${recipient.name}`;

    return message;
  }
  communicate(id,parameters,key){
    const r=this.resident(id);this.requireActive(id);
    if(!this.interactions.available(id)||r.energy<15||r.hunger>=90||this.effects.stress(id)>=85)return {ok:false,skipped:true};
    const primary=this.db.prepare('SELECT * FROM resident_activity WHERE resident_id=?').get(id),result=this.action(id,'talk',parameters,key);
    if(primary&&primary.ends_ms>Date.now()&&!['talk','invite','respond_invitation'].includes(primary.action))this.db.prepare('UPDATE resident_activity SET action=?,from_location=?,to_location=?,started_ms=?,ends_ms=?,message=?,event_id=? WHERE resident_id=?').run(primary.action,primary.from_location,primary.to_location,primary.started_ms,primary.ends_ms,`${primary.message}；同时交流：${result.message}`,primary.event_id,id);
    return result;
  }
  propose(id,{title,description,budget},withinTransaction=false) {
    this.requireActive(id);
    title=clean(title,60);description=clean(description,1000);budget=Number(budget);
    if(!title||!description||!Number.isSafeInteger(budget)||budget<0||budget>10000) throw new WorldError('请填写标题、说明与 0–10000 的整数预算');
    const execute=()=>{
      const r=this.resident(id);
      if(this.db.prepare("SELECT id FROM proposals WHERE author_id=? AND status='open'").get(id)) throw new WorldError('请等待已有议案结束，再发起新议案',409);
      const proposal=uid(); this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?)').run(proposal,id,title,description,budget,'open',this.tick+24,new Date().toISOString());
      this.event('governance',id,`${r.name}发起了「${title}」`,`申请预算 ${budget} 星币，24 世界小时后结算。`); return {id:proposal};
    };return withinTransaction?execute():this.transaction(execute);
  }
  vote(id,proposal,choice,withinTransaction=false) {
    this.requireActive(id);
    if(!['yes','no'].includes(choice)) throw new WorldError('无效的投票选项');
    const execute=()=>{
      this.resident(id);const p=this.db.prepare('SELECT * FROM proposals WHERE id=?').get(proposal);
      if(!p||p.status!=='open'||p.deadline<=this.tick) throw new WorldError('提案不存在或已截止',409);
      this.db.prepare('INSERT INTO votes VALUES(?,?,?) ON CONFLICT(proposal_id,resident_id) DO UPDATE SET choice=excluded.choice').run(proposal,id,choice);this.touch(); return {ok:true};
    };return withinTransaction?execute():this.transaction(execute);
  }
  settleProposals() {
    for(const p of this.db.prepare("SELECT * FROM proposals WHERE status='open' AND deadline<=?").all(this.tick)) {
      const yes=this.db.prepare("SELECT count(*) n FROM votes WHERE proposal_id=? AND choice='yes'").get(p.id).n;
      const no=this.db.prepare("SELECT count(*) n FROM votes WHERE proposal_id=? AND choice='no'").get(p.id).n;
      const population=this.db.prepare('SELECT count(*) n FROM residents r LEFT JOIN resident_controls c ON c.resident_id=r.id WHERE coalesce(c.removed,0)=0').get().n;
      let status=yes>no&&yes+no>=Math.ceil(population*.3)?'passed':'rejected';
      if(status==='passed'&&Number(this.getMeta('treasury'))<p.budget) status='unfunded';
      if(status==='passed') {
        // Move approved funds to a project account. Approval is not construction completion.
        const project=`project-${p.id}`;
        this.db.prepare('INSERT INTO meta VALUES(?,?)').run(project,String(p.budget));
        this.setMeta('treasury',Number(this.getMeta('treasury'))-p.budget);
        if(p.budget>0) this.db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?)').run(uid(),this.tick,'treasury',project,p.budget,`议案拨款：${p.title}`,new Date().toISOString());
      }
      this.db.prepare('UPDATE proposals SET status=? WHERE id=?').run(status,p.id);
      this.event('governance',null,`「${p.title}」${status==='passed'?'通过，资金已划入项目专户':status==='unfunded'?'通过投票但财政不足，未拨款':'未获通过'}`,`赞成 ${yes} / 反对 ${no}；需至少 30% 居民参与。通过不代表设施已建成。`);
    }
  }
  advance() {
    this.transaction(()=>{this.setMeta('tick',this.tick+1);this.touch();this.db.prepare('UPDATE residents SET hunger=min(100,hunger+2) WHERE id NOT IN (SELECT resident_id FROM resident_controls WHERE removed=1)').run();this.settleProposals();this.society.advance();this.interactions.settle();this.tasks.sync();});
    this.navigation.advance();
    for(const r of this.db.prepare("SELECT r.* FROM residents r LEFT JOIN resident_controls c ON c.resident_id=r.id WHERE r.mode='rules' AND coalesce(c.suspended,0)=0 AND coalesce(c.removed,0)=0").all()) {
      try { if(!this.navigation.reserved(r.id))this.runRules(r); } catch(e) { if(!(e instanceof WorldError)) throw e; }
    }
    this.operations.sample();return this.tick;
  }
  runRules(r) {
    const observation=this.observe(r.id);r=observation.self;
    const act=(type,p={})=>{const step=this.landscape.journey(r,{action:type,parameters:p});type=step.action;p=step.parameters;const result=this.action(r.id,type,p,`rule:${this.tick}:${type}`);const follow=observation.interaction.reply||observation.initiative.opportunities.find(o=>o.kind==='social');const current=this.resident(r.id);if(follow&&this.interactions.available(r.id)&&current.energy>=15&&current.hunger<90&&this.effects.stress(r.id)<85){try{this.communicate(r.id,follow.parameters,`rule:${this.tick}:communication`);}catch(error){if(!(error instanceof WorldError))throw error;}}return result;};
    if(r.energy<30||this.effects.stress(r.id)>=70) return act('rest');
    if(observation.decisionGuide.foodSteps?.length&&(r.hunger>=65||observation.goods.some(g=>['bread','grain'].includes(g.id)&&g.stock===0))){const step=observation.decisionGuide.foodSteps[0];return act(step.action,step.parameters);}
    if(r.hunger>45) {
      if(this.inventory(r.id).some(v=>v.item_id==='bread'&&v.quantity>0)) return act('eat');
      if(r.location!=='market') return act('move',{location:'market'});
      if(observation.decisionGuide.canBuyBread)return act('buy',{item_id:'bread',quantity:1});
      if(this.food.state(r).canPrepare)return act('prepare_food');
    }
    if(observation.behavior?.selected){const step=observation.decisionGuide.nextSteps[0];if(step)return act(step.action,step.parameters);}
    const giving=this.pantry.next(r);if(giving?.action==='donate_food')return act(giving.action,giving.parameters);
    if(observation.interaction.reply)return act('talk',observation.interaction.reply.parameters);
    if(observation.interaction.next)return act(observation.interaction.next.action,observation.interaction.next.parameters);
    const responsibility=observation.community.candidates.find(c=>['company_work','contract_work','build_project'].includes(c.action)||c.action==='move');
    if(responsibility)return act(responsibility.action,responsibility.parameters);
    if(!r.job_id) {
      const grain=observation.goods.find(g=>g.id==='grain').stock,bread=observation.goods.find(g=>g.id==='bread').stock,population=observation.residents.length;
      const preferred=/图书|知识|阅读|教育/.test(r.goal)?'librarian':/种植|农|植物/.test(r.goal)?'farmer':/面包|餐|厨/.test(r.goal)?'baker':/工具|制造|手艺/.test(r.goal)?'maker':/建设|设施|桥/.test(r.goal)?'builder':null;
      const urgent=grain<population*2?'farmer':bread<population*2&&grain>=2?'baker':null;
      const jobs=observation.jobs.filter(j=>j.filled<j.capacity).sort((a,b)=>(b.id===urgent?1000:b.id===preferred?500:b.wage)-(a.id===urgent?1000:a.id===preferred?500:a.wage));
      const job=jobs[0];
      return job?act('apply_job',{job_id:job.id}):act('rest');
    }
    const opportunity=observation.initiative.opportunities.find(o=>o.kind==='help'||o.kind==='environment'||o.kind==='meeting'||(this.tick%12===0&&o.kind==='explore'));
    if(opportunity)return act(opportunity.action,opportunity.parameters);
    const job=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(r.job_id);
    return r.location!==job.location?act('move',{location:job.location}):act('work');
  }
  detail(id,privateAccess=false) {
    const r=this.resident(id);
    return {...r,user_id:undefined,socialInvitations:privateAccess?this.interactions.invitations(id):undefined,managedModel:privateAccess?this.db.prepare('SELECT model FROM resident_model_assignments WHERE resident_id=?').get(id)?.model||null:undefined,wellbeing:{stress:this.effects.stress(id)},relations:privateAccess?this.effects.relations(id):undefined,suspended:this.control(id).suspended,removed:this.control(id).removed,activity:this.db.prepare('SELECT * FROM resident_activity WHERE resident_id=?').get(id)||null,inventory:privateAccess?this.inventory(id):undefined,messages:privateAccess?this.inbox(id):undefined,memories:privateAccess?this.db.prepare('SELECT tick,text FROM memories WHERE resident_id=? ORDER BY rowid DESC LIMIT 30').all(id):undefined};
  }
  issueToken(id) {
    const token=`mw_${randomBytes(32).toString('hex')}`;
    this.transaction(()=>{this.db.prepare('DELETE FROM agent_tokens WHERE resident_id=?').run(id);this.db.prepare('INSERT INTO agent_tokens VALUES(?,?,?)').run(hash(token),id,new Date().toISOString());});return token;
  }
  tokenResident(token) { return this.db.prepare('SELECT resident_id FROM agent_tokens WHERE token=?').get(hash(token||''))?.resident_id; }
  snapshot(userId) {
    const mine=userId?this.residentFor(userId):undefined;
    const residents=this.publicResidents(),places=this.places;
    const archivedBalance=this.db.prepare('SELECT coalesce(sum(r.balance),0) AS amount FROM residents r JOIN resident_controls c ON c.resident_id=r.id WHERE c.removed=1').get().amount;
    const proposals=this.db.prepare(`SELECT p.*,r.name AS author,(SELECT count(*) FROM votes WHERE proposal_id=p.id AND choice='yes') AS yes,(SELECT count(*) FROM votes WHERE proposal_id=p.id AND choice='no') AS no FROM proposals p LEFT JOIN residents r ON r.id=p.author_id ORDER BY p.created DESC`).all().map(p=>({...p,myVote:mine?this.db.prepare('SELECT choice FROM votes WHERE proposal_id=? AND resident_id=?').get(p.id,mine.id)?.choice:null}));
    return {pantryStock:this.pantry.stock(),taskStats:this.tasks.stats(),landscape:this.landscape.public(),interactionStats:this.interactions.stats(),community:this.society.public(),socialCircles:this.effects.circles(),environment:this.effects.environment(),name:'晨曦镇',archivedBalance,tick:this.tick,running:this.getMeta('running')==='1',treasury:Number(this.getMeta('treasury')),tax:Number(this.getMeta('tax')),places,residents,goods:this.db.prepare('SELECT * FROM goods').all(),jobs:this.db.prepare('SELECT j.*,(SELECT count(*) FROM residents WHERE job_id=j.id) AS filled FROM jobs j').all(),events:this.db.prepare('SELECT e.*,r.name AS actor_name FROM events e LEFT JOIN residents r ON r.id=e.actor_id ORDER BY e.id DESC LIMIT 80').all(),proposals,me:mine?this.detail(mine.id,true):null,ledger:this.db.prepare('SELECT * FROM ledger ORDER BY rowid DESC LIMIT 15').all(),projects:this.db.prepare("SELECT key,value FROM meta WHERE key LIKE 'project-%'").all()};
  }
}

export function clean(value,max) { if(typeof value!=='string') throw new WorldError('文本格式无效'); if(value.length>max) throw new WorldError(`文本不能超过 ${max} 个字符`); return value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,''); }
