import {randomUUID} from 'node:crypto';
import {WorldError,clean} from './world.mjs';
const number=(v,min,max,label)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw new WorldError(`${label}须为 ${min}–${max} 的整数`);return n;};
const recipes={farmer:{location:'farm',item:'grain',output:4,input:null},maker:{location:'workshop',item:'tools',output:1,input:null},baker:{location:'bakery',item:'bread',output:3,input:'grain'}};
export const societyActions={
 create_company:['name','recipe','capital','wage'],fund_company:['company_id','amount'],withdraw_company:['company_id','amount'],join_company:['company_id'],leave_company:[],company_buy:['company_id','item_id','quantity'],company_work:['company_id'],company_sell:['company_id','item_id','quantity'],
 offer_trade:['item_id','quantity','price'],accept_trade:['trade_id'],cancel_trade:['trade_id'],create_contract:['title','amount','hours'],take_contract:['contract_id'],contract_work:['contract_id'],cancel_contract:['contract_id'],
 buy_property:['property_id'],list_property:['property_id','sale_price','rent_price'],rent_property:['property_id'],build_project:['project_id'],inspect_project:['project_id']
};
export class Society{
 constructor(w){this.w=w;w.db.exec(`
 CREATE TABLE IF NOT EXISTS economy_accounts(id TEXT PRIMARY KEY,balance INTEGER NOT NULL CHECK(balance>=0));
 CREATE TABLE IF NOT EXISTS companies(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES residents(id),name TEXT NOT NULL,recipe TEXT NOT NULL,wage INTEGER NOT NULL CHECK(wage>0));
 CREATE TABLE IF NOT EXISTS company_members(resident_id TEXT PRIMARY KEY REFERENCES residents(id),company_id TEXT REFERENCES companies(id));
 CREATE TABLE IF NOT EXISTS company_stock(company_id TEXT REFERENCES companies(id),item_id TEXT REFERENCES goods(id),quantity INTEGER NOT NULL CHECK(quantity>=0),PRIMARY KEY(company_id,item_id));
 CREATE TABLE IF NOT EXISTS production_orders(id TEXT PRIMARY KEY,company_id TEXT REFERENCES companies(id),worker_id TEXT REFERENCES residents(id),item_id TEXT,quantity INTEGER,started INTEGER,ready INTEGER,status TEXT);
 CREATE TABLE IF NOT EXISTS trade_offers(id TEXT PRIMARY KEY,seller_id TEXT REFERENCES residents(id),buyer_id TEXT REFERENCES residents(id),item_id TEXT,quantity INTEGER,price INTEGER,deadline INTEGER,status TEXT);
 CREATE TABLE IF NOT EXISTS service_contracts(id TEXT PRIMARY KEY,client_id TEXT REFERENCES residents(id),worker_id TEXT REFERENCES residents(id),title TEXT,amount INTEGER,hours INTEGER,progress INTEGER DEFAULT 0,deadline INTEGER,status TEXT);
 CREATE TABLE IF NOT EXISTS housing(id TEXT PRIMARY KEY,name TEXT,owner_id TEXT REFERENCES residents(id),tenant_id TEXT REFERENCES residents(id),lease_end INTEGER DEFAULT 0,sale_price INTEGER,rent_price INTEGER);
 CREATE TABLE IF NOT EXISTS civic_projects(id TEXT PRIMARY KEY REFERENCES proposals(id),progress INTEGER DEFAULT 0,required INTEGER,status TEXT,completed_tick INTEGER);
 CREATE TABLE IF NOT EXISTS society_work(resident_id TEXT REFERENCES residents(id),tick INTEGER,kind TEXT,PRIMARY KEY(resident_id,tick,kind));
 `);if(!w.getMeta('housing_initialized')){for(let i=1;i<=8;i++)w.db.prepare('INSERT OR IGNORE INTO housing(id,name,sale_price,rent_price) VALUES(?,?,1000,10)').run(`home-${i}`,`栖居公寓 ${i} 号`);w.setMeta('housing_initialized','1');}}
 account(id){return this.w.db.prepare('SELECT balance FROM economy_accounts WHERE id=?').get(id);}
 company(id){const c=this.w.db.prepare('SELECT * FROM companies WHERE id=?').get(String(id));if(!c)throw new WorldError('企业不存在');return c;}
 owner(r,c){if(c.owner_id!==r.id)throw new WorldError('仅企业所有者可操作',403);}
 stock(id,item,delta=0){const w=this.w,old=w.db.prepare('SELECT quantity FROM company_stock WHERE company_id=? AND item_id=?').get(id,item)?.quantity||0;if(old+delta<0)throw new WorldError('企业库存不足',409);if(delta)w.db.prepare('INSERT INTO company_stock VALUES(?,?,?) ON CONFLICT(company_id,item_id) DO UPDATE SET quantity=excluded.quantity').run(id,item,old+delta);return old+delta;}
 mark(id,kind){if(this.w.db.prepare('SELECT 1 FROM society_work WHERE resident_id=? AND tick=? AND kind=?').get(id,this.w.tick,kind))throw new WorldError('本小时已经完成工作或其他劳动',409);this.w.db.prepare('INSERT INTO society_work VALUES(?,?,?)').run(id,this.w.tick,kind);}
 labor(r){if(r.energy<20||r.hunger>85||this.w.effects.stress(r.id)>=85)throw new WorldError('当前状态不适合劳动');if(this.w.db.prepare("SELECT 1 FROM ledger WHERE tick=? AND to_id=? AND reason LIKE '劳动报酬%'").get(this.w.tick,r.id))throw new WorldError('本小时已经完成劳动',409);this.mark(r.id,'labor');this.w.db.prepare('UPDATE residents SET energy=energy-16,hunger=min(100,hunger+12) WHERE id=?').run(r.id);this.w.effects.stress(r.id,4);}
 operate(r,action,p){const w=this.w,db=w.db;
  if(action==='create_company'){
   const name=clean(p.name,40),recipe=String(p.recipe);if(!name||!recipes[recipe])throw new WorldError('填写名称并选择 farmer / maker / baker 配方');if(db.prepare('SELECT id FROM companies WHERE owner_id=?').get(r.id))throw new WorldError('每位居民最多创办一家企业');
   const capital=number(p.capital,50,10000,'启动资金'),wage=number(p.wage,1,100,'工资'),id=`company-${randomUUID()}`;db.prepare('INSERT INTO economy_accounts VALUES(?,0)').run(id);db.prepare('INSERT INTO companies VALUES(?,?,?,?,?)').run(id,r.id,name,recipe,wage);w.transfer(r.id,id,capital,'企业启动资金');db.prepare('INSERT INTO company_members VALUES(?,?) ON CONFLICT(resident_id) DO UPDATE SET company_id=excluded.company_id').run(r.id,id);return `创办了「${name}」，注资 ${capital} 星币`;
  }
  if(['fund_company','withdraw_company','company_buy','company_sell','company_work','join_company'].includes(action)){
   const c=this.company(p.company_id),rec=recipes[c.recipe];
   if(['fund_company','withdraw_company'].includes(action)){this.owner(r,c);const amount=number(p.amount,1,10000,'金额');w.transfer(action==='fund_company'?r.id:c.id,action==='fund_company'?c.id:r.id,amount,action==='fund_company'?'企业注资':'企业提款');return '完成企业资金转移';}
   if(action==='join_company'){if(db.prepare('SELECT count(*) n FROM company_members WHERE company_id=?').get(c.id).n>=5)throw new WorldError('企业岗位已满');db.prepare('INSERT INTO company_members VALUES(?,?) ON CONFLICT(resident_id) DO UPDATE SET company_id=excluded.company_id').run(r.id,c.id);return `自愿加入「${c.name}」，接受每次劳动 ${c.wage} 星币工资` ;}
   if(action==='company_work'){
    if(db.prepare('SELECT company_id FROM company_members WHERE resident_id=?').get(r.id)?.company_id!==c.id)throw new WorldError('请先自愿加入该企业',403);if(r.location!==rec.location)throw new WorldError('请先到企业生产地点');
    if(rec.input)this.stock(c.id,rec.input,-2);this.labor(r);w.transfer(c.id,r.id,c.wage,`劳动报酬 · 企业 ${c.name}`);db.prepare('INSERT INTO production_orders VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),c.id,r.id,rec.item,rec.output,w.tick,w.tick+2,'producing');w.effects.pollution(rec.location,c.recipe==='maker'?2:c.recipe==='baker'?1:-1);return `在「${c.name}」开始生产，2 世界小时后入企业库存`;
   }
   this.owner(r,c);const quantity=number(p.quantity,1,20,'数量'),g=db.prepare('SELECT * FROM goods WHERE id=?').get(String(p.item_id));if(!g)throw new WorldError('商品不存在');if(r.location!=='market')throw new WorldError('企业采购和出售须本人前往集市');
   if(action==='company_buy'){if(g.stock<quantity)throw new WorldError('公共库存不足');w.transfer(c.id,'treasury',g.price*quantity,'企业采购');db.prepare('UPDATE goods SET stock=stock-? WHERE id=?').run(quantity,g.id);this.stock(c.id,g.id,quantity);return '企业采购完成';}
   this.stock(c.id,g.id,-quantity);w.transfer('treasury',c.id,g.price*quantity,'公共集市收购企业产品');db.prepare('UPDATE goods SET stock=stock+? WHERE id=?').run(quantity,g.id);return '企业产品已出售给公共集市';
  }
  if(action==='leave_company'){db.prepare('DELETE FROM company_members WHERE resident_id=?').run(r.id);return '退出了企业岗位';}
  if(action==='offer_trade'){
   const quantity=number(p.quantity,1,20,'数量'),price=number(p.price,1,500,'单价'),item=String(p.item_id);if(!db.prepare('SELECT id FROM goods WHERE id=?').get(item))throw new WorldError('商品不存在');if(w.inventory(r.id).find(i=>i.item_id===item)?.quantity<quantity||!w.inventory(r.id).find(i=>i.item_id===item))throw new WorldError('背包物品不足');if(db.prepare("SELECT count(*) n FROM trade_offers WHERE seller_id=? AND status='open'").get(r.id).n>=5)throw new WorldError('最多同时发布五笔交易');
   db.prepare('UPDATE inventory SET quantity=quantity-? WHERE resident_id=? AND item_id=?').run(quantity,r.id,item);db.prepare('INSERT INTO trade_offers VALUES(?,?,NULL,?,?,?,?,?)').run(randomUUID(),r.id,item,quantity,price,w.tick+24,'open');return '发布了居民交易，物品已托管，24小时内可成交';
  }
  if(['accept_trade','cancel_trade'].includes(action)){
   const t=db.prepare('SELECT * FROM trade_offers WHERE id=?').get(String(p.trade_id));if(!t||t.status!=='open'||t.deadline<=w.tick)throw new WorldError('交易已结束');
   if(action==='cancel_trade'){if(t.seller_id!==r.id)throw new WorldError('只能撤销自己的交易',403);w.addItem(r.id,t.item_id,t.quantity);db.prepare("UPDATE trade_offers SET status='cancelled' WHERE id=?").run(t.id);return '撤销交易，托管物品已归还';}
   if(t.seller_id===r.id)throw new WorldError('不能购买自己的交易');w.requireActive(t.seller_id);w.transfer(r.id,t.seller_id,t.quantity*t.price,'居民物品交易');w.addItem(r.id,t.item_id,t.quantity);db.prepare("UPDATE trade_offers SET status='completed',buyer_id=? WHERE id=?").run(r.id,t.id);return '双方完成物品与星币交换';
  }
  if(action==='create_contract'){
   const title=clean(p.title,80),amount=number(p.amount,1,10000,'报酬'),hours=number(p.hours,1,24,'工时');if(!title)throw new WorldError('委托内容不能为空');if(db.prepare("SELECT count(*) n FROM service_contracts WHERE client_id=? AND status IN ('open','working')").get(r.id).n>=3)throw new WorldError('最多同时发布三份委托');const id=`contract-${randomUUID()}`;db.prepare('INSERT INTO economy_accounts VALUES(?,0)').run(id);db.prepare('INSERT INTO service_contracts VALUES(?,?,NULL,?,?,?,0,?,?)').run(id,r.id,title,amount,hours,w.tick+72,'open');w.transfer(r.id,id,amount,'委托报酬托管');return '发布了计时劳务委托，报酬已托管；72小时内完成约定工时后结算';
  }
  if(['take_contract','contract_work','cancel_contract'].includes(action)){
   const c=db.prepare('SELECT * FROM service_contracts WHERE id=?').get(String(p.contract_id));if(!c||!['open','working'].includes(c.status)||c.deadline<=w.tick)throw new WorldError('委托已结束');
   if(action==='cancel_contract'){if(c.client_id!==r.id||c.status!=='open')throw new WorldError('仅委托人可撤销尚未承接的委托',403);w.transfer(c.id,c.client_id,c.amount,'未承接委托退款');db.prepare("UPDATE service_contracts SET status='cancelled' WHERE id=?").run(c.id);return '委托已撤销并退款';}
   if(action==='take_contract'){if(c.status!=='open'||c.client_id===r.id)throw new WorldError('不能承接此委托');w.requireActive(c.client_id);db.prepare("UPDATE service_contracts SET worker_id=?,status='working' WHERE id=?").run(r.id,c.id);return '自愿承接计时劳务条款；全部工时完成后结算，逾期未完成退款';}
   if(c.worker_id!==r.id)throw new WorldError('不是此委托的承接人',403);this.labor(r);db.prepare('UPDATE service_contracts SET progress=progress+1 WHERE id=?').run(c.id);if(c.progress+1>=c.hours){w.transfer(c.id,r.id,c.amount,'计时劳务完成结算');db.prepare("UPDATE service_contracts SET status='completed' WHERE id=?").run(c.id);}return '完成了一小时委托劳动';
  }
  if(['buy_property','list_property','rent_property'].includes(action)){
   const h=db.prepare('SELECT * FROM housing WHERE id=?').get(String(p.property_id));if(!h)throw new WorldError('房屋不存在');
   if(action==='list_property'){if(h.owner_id!==r.id)throw new WorldError('仅房主可挂牌',403);if(h.tenant_id&&h.lease_end>w.tick)throw new WorldError('租期内不能更改挂牌条款');db.prepare('UPDATE housing SET sale_price=?,rent_price=? WHERE id=?').run(number(p.sale_price,0,10000,'售价'),number(p.rent_price,0,1000,'24小时租金'),h.id);return '更新房产挂牌，0表示不开放该项交易';}
   if(action==='buy_property'){if(!h.sale_price||h.owner_id===r.id||h.tenant_id&&h.lease_end>w.tick)throw new WorldError('房屋当前不可购买');w.transfer(r.id,h.owner_id||'treasury',h.sale_price,'房产购买');db.prepare('UPDATE housing SET owner_id=?,sale_price=0,rent_price=0 WHERE id=?').run(r.id,h.id);return '购得房屋产权，未自动开放转售或出租';}
   if(!h.rent_price||h.owner_id===r.id||h.tenant_id&&h.lease_end>w.tick)throw new WorldError('房屋当前不可租赁');if(db.prepare('SELECT id FROM housing WHERE tenant_id=? AND lease_end>?').get(r.id,w.tick))throw new WorldError('已持有有效租约');w.transfer(r.id,h.owner_id||'treasury',h.rent_price,'24小时房屋租约');db.prepare('UPDATE housing SET tenant_id=?,lease_end=? WHERE id=?').run(r.id,w.tick+24,h.id);return '租赁房屋24小时，不自动续费；有效住房休息额外恢复5精力';
  }
  if(['build_project','inspect_project'].includes(action)){
   const c=db.prepare('SELECT * FROM civic_projects WHERE id=?').get(String(p.project_id));if(!c)throw new WorldError('建设项目不存在');
   if(action==='inspect_project'){w.requireAdmin(r.user_id);if(c.status!=='inspection'||c.progress<c.required)throw new WorldError('尚未达到验收工时');const remaining=Number(w.getMeta(`project-${c.id}`)||0);if(remaining)w.transfer(`project-${c.id}`,'treasury',remaining,'项目验收后结余归还');db.prepare("UPDATE civic_projects SET status='completed',completed_tick=? WHERE id=?").run(w.tick,c.id);w.effects.pollution('square',-10);w.landscape.completeProject(c.id,db.prepare('SELECT title FROM proposals WHERE id=?').get(c.id).title);return '项目已验收，公共设施开放，剩余拨款归还财政';}
   if(c.status!=='building')throw new WorldError('项目当前不在施工中');if(r.location!=='hall')throw new WorldError('请前往市政厅参与公共建设');const tools=db.prepare("SELECT stock FROM goods WHERE id='tools'").get().stock;if(tools<1)throw new WorldError('公共工具库存不足');this.labor(r);db.prepare("UPDATE goods SET stock=stock-1 WHERE id='tools'").run();const wage=Math.min(10,Number(w.getMeta(`project-${c.id}`)||0));if(wage)w.transfer(`project-${c.id}`,r.id,wage,'劳动报酬 · 公共项目建设');db.prepare('UPDATE civic_projects SET progress=progress+1,status=? WHERE id=?').run(c.progress+1>=c.required?'inspection':'building',c.id);return '完成一小时公共建设，消耗一套工具；达到工时后等待管理员验收';
  }
  throw new WorldError('不支持的社会行动');
 }
 restBonus(id){return this.w.db.prepare('SELECT id FROM housing WHERE owner_id=? OR (tenant_id=? AND lease_end>?)').get(id,id,this.w.tick)?5:0;}
 context(r){
  const state=this.public(),own=state.companies.find(c=>c.owner_id===r.id),member=state.companies.find(c=>c.members.includes(r.id));
  const offers=state.trades.filter(t=>t.status==='open'),contracts=state.contracts.filter(c=>c.client_id===r.id||c.worker_id===r.id||c.status==='open').slice(0,3),projects=state.construction.filter(c=>c.status!=='completed').slice(0,2),candidates=[];
  if(member&&member.balance>=member.wage&&(member.recipe!=='baker'||member.stock.some(g=>g.item_id==='grain'&&g.quantity>=2)))candidates.push({action:r.location===member.location?'company_work':'move',parameters:r.location===member.location?{company_id:member.id}:{location:member.location},reason:'已接受企业岗位，可参与生产'});
  const assigned=contracts.find(c=>c.worker_id===r.id&&c.status==='working');if(assigned)candidates.unshift({action:'contract_work',parameters:{contract_id:assigned.id},reason:'继续履行本人已接受的计时劳务'});
  if(r.job_id==='builder'&&projects.some(p=>p.status==='building')){const c=projects.find(p=>p.status==='building');candidates.push({action:r.location==='hall'?'build_project':'move',parameters:r.location==='hall'?{project_id:c.id}:{location:'hall'},reason:'公共项目需要施工，消耗公共工具并支付工资'});}
  if(!own&&/企业|创业|公司|开.*店/.test(r.goal)&&r.balance>=100)candidates.push({action:'create_company',parameters:{name:`${r.name}的合作工坊`.slice(0,40),recipe:r.job_id in recipes?r.job_id:'maker',capital:100,wage:10},reason:'有启动资金，可按目标创办企业'});
  const catalog={};for(const c of candidates.slice(0,3))if(societyActions[c.action])catalog[c.action]={parameters:societyActions[c.action],condition:c.reason};
  return {companies:[...new Map([own,member].filter(Boolean).map(c=>[c.id,c])).values()],contracts,trades:offers.slice(0,2),construction:projects,candidates:candidates.slice(0,3),actionCatalog:catalog};
 }
 advance(){const w=this.w,db=w.db;
  for(const p of db.prepare("SELECT * FROM proposals WHERE status='unfunded' ORDER BY deadline,id").all()){if(Number(w.getMeta('treasury'))<p.budget)continue;w.setMeta(`project-${p.id}`,0);if(p.budget)w.transfer('treasury',`project-${p.id}`,p.budget,'待资金项目补拨');db.prepare("UPDATE proposals SET status='passed' WHERE id=?").run(p.id);w.event('governance',null,`「${p.title}」资金已补足，开始施工准备`);}
  for(const p of db.prepare("SELECT * FROM proposals WHERE status='passed'").all())db.prepare("INSERT OR IGNORE INTO civic_projects(id,required,status) VALUES(?,?,'building')").run(p.id,Math.max(2,Math.min(24,Math.ceil(p.budget/50))));
  for(const o of db.prepare("SELECT * FROM production_orders WHERE status='producing' AND ready<=?").all(w.tick)){this.stock(o.company_id,o.item_id,o.quantity);db.prepare("UPDATE production_orders SET status='completed' WHERE id=?").run(o.id);w.event('work',o.worker_id,'企业生产订单完工',`${o.quantity} 件产品进入企业库存`);}
  for(const t of db.prepare("SELECT * FROM trade_offers WHERE status='open' AND deadline<=?").all(w.tick)){w.addItem(t.seller_id,t.item_id,t.quantity);db.prepare("UPDATE trade_offers SET status='expired' WHERE id=?").run(t.id);w.memory(t.seller_id,'居民交易到期，托管物品已退回');}
  for(const c of db.prepare("SELECT * FROM service_contracts WHERE status IN ('open','working') AND deadline<=?").all(w.tick)){w.transfer(c.id,c.client_id,c.amount,'委托到期退款');db.prepare("UPDATE service_contracts SET status='expired' WHERE id=?").run(c.id);}
  db.prepare('UPDATE housing SET tenant_id=NULL,lease_end=0 WHERE lease_end>0 AND lease_end<=?').run(w.tick);
 }
 public(){const db=this.w.db;return {companies:db.prepare('SELECT c.*,a.balance FROM companies c JOIN economy_accounts a ON a.id=c.id').all().map(c=>({...c,location:recipes[c.recipe].location,members:db.prepare('SELECT resident_id FROM company_members WHERE company_id=?').all(c.id).map(r=>r.resident_id),stock:db.prepare('SELECT item_id,quantity FROM company_stock WHERE company_id=?').all(c.id)})),orders:db.prepare('SELECT * FROM production_orders ORDER BY rowid DESC LIMIT 30').all(),trades:db.prepare('SELECT * FROM trade_offers ORDER BY rowid DESC LIMIT 40').all(),contracts:db.prepare('SELECT * FROM service_contracts ORDER BY rowid DESC LIMIT 40').all(),housing:db.prepare('SELECT * FROM housing').all(),construction:db.prepare('SELECT c.*,p.title FROM civic_projects c JOIN proposals p ON p.id=c.id').all(),accountTotal:db.prepare('SELECT coalesce(sum(balance),0) total FROM economy_accounts').get().total};}
}
