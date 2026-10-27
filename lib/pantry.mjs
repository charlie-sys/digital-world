import {WorldError} from './world.mjs';

export const pantryActions={
 donate_food:{parameters:['item_id','quantity'],condition:'在market自愿捐赠本人面包或谷物1–10份；饥饿<65且为自己保留至少一份食物，无额外奖金'},
 community_meal:{parameters:[],condition:'在market，饥饿>=65、无自备食物且无法负担当前可购食物；食柜有捐赠，每6世界小时最多一餐，直接食用，不可转卖'}
};
export class Pantry{
 constructor(w){this.w=w;w.db.exec(`CREATE TABLE IF NOT EXISTS pantry_stock(item_id TEXT PRIMARY KEY CHECK(item_id IN ('bread','grain')),quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity>=0));
 CREATE TABLE IF NOT EXISTS pantry_transfers(id INTEGER PRIMARY KEY AUTOINCREMENT,resident_id TEXT NOT NULL REFERENCES residents(id),kind TEXT NOT NULL CHECK(kind IN ('donation','meal')),item_id TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>0),tick INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS pantry_history ON pantry_transfers(tick);
 INSERT OR IGNORE INTO pantry_stock VALUES('bread',0),('grain',0);`);}
 stock(){return Object.fromEntries(this.w.db.prepare('SELECT item_id,quantity FROM pantry_stock').all().map(r=>[r.item_id,r.quantity]));}
 state(r){const w=this.w,inventory=w.inventory(r.id),quantity=id=>inventory.find(i=>i.item_id===id)?.quantity||0,bread=quantity('bread'),grain=quantity('grain'),stock=this.stock(),goods=w.db.prepare("SELECT id,price,stock FROM goods WHERE id IN ('bread','grain')").all();
 const affordable=goods.some(g=>g.stock>0&&r.balance>=g.price),last=w.db.prepare("SELECT max(tick) tick FROM pantry_transfers WHERE resident_id=? AND kind='meal'").get(r.id).tick,nextMealTick=last===null?null:last+6,eligible=r.hunger>=65&&!bread&&!grain&&!affordable&&(nextMealTick===null||w.tick>=nextMealTick),item=stock.bread?'bread':stock.grain?'grain':null;
 const donations=['bread','grain'].map(item_id=>({item_id,maximum:Math.min(10,Math.max(0,quantity(item_id)-((item_id==='bread'?grain:bread)?0:1)))})).filter(i=>i.maximum>0);
 return {stock,location:'market',eligible,canReceive:eligible&&Boolean(item)&&r.location==='market',mealItem:item,nextMealTick,donations:r.hunger<65?donations:[],canDonate:r.location==='market'&&r.hunger<65&&donations.length>0};
 }
 context(r){const s=this.state(r);if(!s.stock.bread&&!s.stock.grain&&!s.eligible&&!s.canDonate&&s.nextMealTick===null)return undefined;return {location:s.location,stock:s.stock,eligible:s.eligible,canReceive:s.canReceive,donations:s.canDonate?s.donations:[],nextMealTick:s.nextMealTick};}
 next(r){const s=this.state(r);if(s.eligible&&s.mealItem)return r.location==='market'?{action:'community_meal',parameters:{}}:{action:'move',parameters:{location:'market'}};
 // Autonomous giving uses only surplus already carried, never buys food merely
 // to manufacture contributions or travels away from an existing commitment.
 if(r.hunger<45&&r.energy>=30&&r.location==='market'&&!this.w.tasks.current(r.id)&&s.stock.bread+s.stock.grain<6){const i=s.donations.find(i=>i.maximum>=2);if(i)return {action:'donate_food',parameters:{item_id:i.item_id,quantity:1}};}return null;
 }
 operate(r,action,p){const w=this.w,s=this.state(r);if(action==='donate_food'){
  const quantity=Number(p.quantity),limit=s.donations.find(i=>i.item_id===p.item_id)?.maximum||0;
  if(!s.canDonate||!Number.isSafeInteger(quantity)||quantity<1||quantity>limit)throw new WorldError('请到晨光集市捐赠本人多余的面包或谷物，每次1–10份，并为自己保留至少一份食物');
  w.db.prepare('UPDATE inventory SET quantity=quantity-? WHERE resident_id=? AND item_id=?').run(quantity,r.id,p.item_id);w.db.prepare('UPDATE pantry_stock SET quantity=quantity+? WHERE item_id=?').run(quantity,p.item_id);this.record(r.id,'donation',p.item_id,quantity);
  return `向社区互助食柜捐赠${quantity}${p.item_id==='bread'?'份面包':'袋谷物'}，为需要帮助的邻居留下一餐`;
 }
 if(!s.canReceive)throw new WorldError('暂不符合互助用餐条件：需在集市、饥饿至少65、无自备或可负担食物、食柜有补给，且距上次用餐至少6世界小时');
 w.db.prepare('UPDATE pantry_stock SET quantity=quantity-1 WHERE item_id=?').run(s.mealItem);w.db.prepare('UPDATE residents SET hunger=max(0,hunger-?),energy=min(100,energy+?) WHERE id=?').run(s.mealItem==='bread'?45:30,s.mealItem==='bread'?8:2,r.id);this.record(r.id,'meal',s.mealItem,1);
 return `在社区互助食柜食用一份${s.mealItem==='bread'?'捐赠面包':'谷物简餐'}，补给来自居民实际捐赠`;
 }
 record(id,kind,item,quantity){this.w.db.prepare('INSERT INTO pantry_transfers(resident_id,kind,item_id,quantity,tick) VALUES(?,?,?,?,?)').run(id,kind,item,quantity,this.w.tick);}
 public(id){const w=this.w,totals=w.db.prepare("SELECT coalesce(sum(CASE WHEN kind='donation' THEN quantity ELSE 0 END),0) donated,coalesce(sum(kind='meal'),0) meals FROM pantry_transfers").get(),recentDonations=w.db.prepare("SELECT r.name,t.item_id,t.quantity,t.tick FROM pantry_transfers t JOIN residents r ON r.id=t.resident_id WHERE t.kind='donation' ORDER BY t.id DESC LIMIT 5").all();return {stock:this.stock(),...totals,recentDonations,mine:id?this.state(w.resident(id)):null,policy:'居民真实捐赠；急需且暂无可负担食物时就地食用，每6世界小时一餐。领取者不在捐赠公示中展示。'};}
}
