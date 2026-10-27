// Shared deterministic world generation: browser and server use identical cells.
export const CHUNK_SIZE=8;
export const BASE_GRID={farm:[2.1,1.7],library:[5.5,2],workshop:[7.6,2],homes:[1.7,5.1],square:[4.5,4.5],hall:[7.3,4.5],bakery:[3,7],market:[6.4,7.3]};
export function hash(seed,x,z,salt=0){let h=2166136261;for(const c of `${seed}:${x}:${z}:${salt}`){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}h^=h>>>16;h=Math.imul(h,0x7feb352d);h^=h>>>15;return (h>>>0)/4294967296;}
function noise(seed,x,z,scale){const a=Math.floor(x/scale),b=Math.floor(z/scale),fx=x/scale-a,fz=z/scale-b,s=t=>t*t*(3-2*t),u=s(fx),v=s(fz);return (hash(seed,a,b)*(1-u)+hash(seed,a+1,b)*u)*(1-v)+(hash(seed,a,b+1)*(1-u)+hash(seed,a+1,b+1)*u)*v;}
export function cellAt(seed,x,z){
 x=Math.floor(x);z=Math.floor(z);const town=x>=0&&x<10&&z>=0&&z<10,n=noise(seed,x+319,z-137,24)*.75+noise(seed,x-79,z+239,9)*.25;
 const biome=town?'town':n<.28?'water':n<.38?'shore':n>.76?'highland':n>.55?'forest':'meadow',road=town?(x===4||x===5||z===4||z===5):((Math.abs(x)%24===4||Math.abs(z)%24===4)&&biome!=='water');
 const tree=!town&&!road&&biome==='forest'&&hash(seed,x,z,3)>.34,rock=!town&&!road&&biome==='highland'&&hash(seed,x,z,4)>.35;
 const poi=!town&&!road&&biome!=='water'&&hash(seed,x,z,19)>.982?['camp','grove','ruins','cabin','spring','lookout'][Math.floor(hash(seed,x,z,20)*6)]:null;
 return {x,z,biome,road,tree,rock,flowers:!road&&biome==='meadow'&&hash(seed,x,z,5)>.5,walkable:biome!=='water',buildable:!road&&!poi&&!['water','highland'].includes(biome),poi,elevation:biome==='highland'?.5:0,wood:tree?8:0,stone:rock?12:0};
}
export function chunkAt(seed,cx,cz){const cells=[];for(let z=cz*CHUNK_SIZE;z<(cz+1)*CHUNK_SIZE;z++)for(let x=cx*CHUNK_SIZE;x<(cx+1)*CHUNK_SIZE;x++)cells.push(cellAt(seed,x,z));return {cx,cz,cells};}
const poiNames={camp:'林间营地',grove:'花影秘境',ruins:'古老石庭',cabin:'旅行者小屋',spring:'清泉驿站',lookout:'远眺观景台'};
export function naturalSite(seed,x,z){const cell=cellAt(seed,x,z);if(!cell.poi)return null;return {id:`poi:${x}:${z}`,name:`${poiNames[cell.poi]} · ${x},${z}`,kind:cell.poi,worldX:x+.5,worldZ:z+.5,interior:cell.poi,generated:true};}
export function parseCoordinate(id){const m=String(id).match(/^(wild|poi):(-?\d+):(-?\d+)$/);if(!m)return null;const x=Number(m[2]),z=Number(m[3]);return Number.isSafeInteger(x)&&Number.isSafeInteger(z)&&Math.abs(x)<=1000000&&Math.abs(z)<=1000000?{type:m[1],x,z}:null;}
export function isoPoint(x,z){return [500+(x-z)*47,58+(x+z)*23];}
export function fromIso(x,y){return [((x-500)/47+(y-58)/23)/2,((y-58)/23-(x-500)/47)/2];}
export const biomeNames={town:'晨曦镇',water:'湖泊',shore:'河滩',forest:'林地',meadow:'草甸',highland:'岩石高地'};
