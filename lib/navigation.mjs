import {WorldError} from './world.mjs';
// Bounded A* over deterministic terrain. Long journeys are planned in local legs.
export function findWalkingPath(start,goal,walkable,{limit=18000,range=96}={}){
 const key=(x,z)=>`${x},${z}`,distance=(x,z)=>Math.hypot(goal.x-x,goal.z-z),open=[],cost=new Map(),parent=new Map(),nodes=new Map();
 const push=n=>{open.push(n);let i=open.length-1;while(i){const p=(i-1)>>1;if(open[p].f<=n.f)break;open[i]=open[p];i=p;}open[i]=n;};
 const pop=()=>{const first=open[0],last=open.pop();if(open.length){let i=0;while(i*2+1<open.length){let c=i*2+1;if(c+1<open.length&&open[c+1].f<open[c].f)c++;if(open[c].f>=last.f)break;open[i]=open[c];i=c;}open[i]=last;}return first;};
 const first={...start,g:0,f:distance(start.x,start.z)};push(first);cost.set(key(start.x,start.z),0);nodes.set(key(start.x,start.z),first);
 for(let count=0;open.length&&count<limit;count++){const n=pop(),nk=key(n.x,n.z);if(n.g!==cost.get(nk))continue;if(n.x===goal.x&&n.z===goal.z){const path=[];let k=nk;while(parent.has(k)){path.push(nodes.get(k));k=parent.get(k);}return path.reverse().map(({x,z})=>({x,z}));}
  for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dz)continue;const x=n.x+dx,z=n.z+dz;if(Math.abs(x-start.x)>range||Math.abs(z-start.z)>range||!walkable(x,z)||dx&&dz&&(!walkable(n.x+dx,n.z)||!walkable(n.x,n.z+dz)))continue;const g=n.g+Math.hypot(dx,dz),k=key(x,z);if(g>=(cost.get(k)??Infinity))continue;cost.set(k,g);parent.set(k,nk);const next={x,z,g,f:g+distance(x,z)};nodes.set(k,next);push(next);}
 }return null;
}
export class Navigation{
 constructor(w){this.w=w;w.db.exec(`CREATE TABLE IF NOT EXISTS resident_navigation(resident_id TEXT PRIMARY KEY REFERENCES residents(id),x INTEGER,z INTEGER,site_id TEXT,status TEXT,message TEXT,path TEXT DEFAULT '[]',last_tick INTEGER DEFAULT -1,steps INTEGER DEFAULT 0);`);if(!w.db.prepare('PRAGMA table_info(resident_navigation)').all().some(c=>c.name==='trail'))w.db.exec("ALTER TABLE resident_navigation ADD COLUMN trail TEXT DEFAULT '[]'");}
 get(id){const row=this.w.db.prepare('SELECT * FROM resident_navigation WHERE resident_id=?').get(id);if(!row)return null;const {path,...publicRow}=row;return {...publicRow,trail:JSON.parse(publicRow.trail||'[]')};}
 reserved(id){const n=this.get(id);return n&&(n.status==='active'||n.last_tick===this.w.tick&&n.status!=='cancelled');}
 cancel(id){this.w.db.prepare("UPDATE resident_navigation SET status='cancelled',message='已取消行程',path='[]' WHERE resident_id=? AND status IN ('active','blocked')").run(id);return '已取消行程';}
 start(r,p){const x=Number(p.x),z=Number(p.z);if(!Number.isSafeInteger(x)||!Number.isSafeInteger(z)||Math.abs(x)>1000000||Math.abs(z)>1000000)throw new WorldError('目的地须为有效整数坐标（±1000000以内）');if(!this.w.landscape.cell(x,z).walkable)throw new WorldError('目的地是水面，无法步行到达');const site=p.location?this.w.findPlace(String(p.location)):null;if(p.location&&(!site||Math.floor(site.worldX)!==x||Math.floor(site.worldZ)!==z))throw new WorldError('目的地场所与所选地块不一致');this.w.db.prepare("INSERT INTO resident_navigation(resident_id,x,z,site_id,status,message,path,last_tick,steps) VALUES(?,?,?,?,'active','正在规划路线','[]',-1,0) ON CONFLICT(resident_id) DO UPDATE SET x=excluded.x,z=excluded.z,site_id=excluded.site_id,status='active',message='正在规划路线',path='[]',steps=0").run(r.id,x,z,site?.id||null);
  this.step(r.id);return this.get(r.id).message;
 }
 step(id){const w=this.w,n=w.db.prepare("SELECT * FROM resident_navigation WHERE resident_id=? AND status='active'").get(id);if(!n)return;const control=w.control(id);if(control.suspended||control.removed)return;if(n.last_tick===w.tick){w.db.prepare("UPDATE resident_navigation SET message='目的地已保存，下一世界小时继续行进' WHERE resident_id=?").run(id);return;}
  const r=w.resident(id),pos=w.landscape.position(r.location);if(!pos)return;const here={x:Math.floor(pos.x),z:Math.floor(pos.z)},dest={x:n.x,z:n.z};let message='',status='active',path=JSON.parse(n.path),location=r.location,trail=[];
  if(here.x===dest.x&&here.z===dest.z){status='arrived';location=n.site_id||w.db.prepare("SELECT id FROM world_buildings WHERE x=? AND z=? AND status='completed'").get(dest.x,dest.z)?.id||w.landscape.site(`poi:${dest.x}:${dest.z}`)?.id||`wild:${dest.x}:${dest.z}`;message=`已到达指定位置 (${dest.x}, ${dest.z})`;}
  else if(r.energy<10){w.db.prepare('UPDATE residents SET energy=min(100,energy+25) WHERE id=?').run(id);w.effects.stress(id,-8);message='行程中就地休息恢复精力，下一小时继续';}
  else{
   if(!path.length){let leg=dest;if(Math.hypot(dest.x-here.x,dest.z-here.z)>64){const f=48/Math.hypot(dest.x-here.x,dest.z-here.z);leg={x:Math.round(here.x+(dest.x-here.x)*f),z:Math.round(here.z+(dest.z-here.z)*f)};if(!w.landscape.cell(leg.x,leg.z).walkable){const options=[];for(let z=leg.z-12;z<=leg.z+12;z++)for(let x=leg.x-12;x<=leg.x+12;x++)if(w.landscape.cell(x,z).walkable)options.push({x,z,d:Math.hypot(x-leg.x,z-leg.z)});options.sort((a,b)=>a.d-b.d);leg=options[0]||leg;}}
    const terrain=new Map(),walkable=(x,z)=>{const key=`${x},${z}`;if(!terrain.has(key))terrain.set(key,Math.abs(x)<=1000000&&Math.abs(z)<=1000000&&w.landscape.cell(x,z).walkable);return terrain.get(key);};path=findWalkingPath(here,leg,walkable)||[];
   }
   if(!path.length){status='blocked';message='暂未找到可步行路线，请选择岸边或更近的中途点后重试';}
   else{let count=Math.min(5,path.length);while(count>1&&Math.hypot(path[count-1].x+.5-pos.x,path[count-1].z+.5-pos.z)>8)count--;const next=path[count-1];trail=[{x:pos.x,z:pos.z},...path.slice(0,count).map(p=>({x:p.x+.5,z:p.z+.5}))];path=path.slice(count);const arrived=next.x===dest.x&&next.z===dest.z;location=arrived&&n.site_id?n.site_id:w.db.prepare("SELECT id FROM world_buildings WHERE x=? AND z=? AND status='completed'").get(next.x,next.z)?.id||w.landscape.site(`poi:${next.x}:${next.z}`)?.id||`wild:${next.x}:${next.z}`;status=arrived?'arrived':'active';message=arrived?`已到达指定位置 (${dest.x}, ${dest.z})`:`正前往 (${dest.x}, ${dest.z})，当前位置 (${next.x}, ${next.z})`;w.db.prepare('UPDATE residents SET energy=energy-5,hunger=min(100,hunger+2) WHERE id=?').run(id);}
  }
  w.db.prepare('UPDATE residents SET location=? WHERE id=?').run(location,id);w.db.prepare('UPDATE resident_navigation SET status=?,message=?,path=?,last_tick=?,steps=steps+1,trail=? WHERE resident_id=?').run(status,message,JSON.stringify(path),w.tick,JSON.stringify(trail),id);w.activity(id,location!==r.location?'navigate':r.energy<10?'rest':'navigate',r.location,location,message);w.touch();
  if(status==='arrived'||status==='blocked'){w.memory(id,message);w.event('life',id,`${r.name}${message}`,'地图指定目的地行程');}
 }
 advance(){for(const n of this.w.db.prepare("SELECT resident_id FROM resident_navigation WHERE status='active'").all())this.w.transaction(()=>this.step(n.resident_id));}
}
