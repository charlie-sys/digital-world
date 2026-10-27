import {hash} from './terrain.js';
export const SCENE_NAMES={house:'起居室与厨房',homes:'起居室与厨房',library:'书架与阅览区',bakery:'烤炉与面包操作间',cafe:'咖啡吧与邻里座位',workshop:'工坊操作台',hall:'公共议事厅',market:'集市货架与摊位',farm:'温室与作物田',garden:'花园小径',square:'中央广场',camp:'林间露营地',grove:'花影林地',ruins:'古石庭院',spring:'泉水驿站',cabin:'旅行者木屋',lookout:'山野观景台'};
const box=(x,y,z,w,h,d,color,label)=>({x,y,z,w,h,d,color,label});
export function sceneLayout(kind,state={}){
 const objects=[],outdoor=['square','farm','garden','camp','grove','ruins','spring','lookout'].includes(kind),add=(...a)=>objects.push(box(...a));
 const table=(x,z)=>{add(x,.82,z,1.8,.16,1.1,'#a27b56');for(const dx of [-.7,.7])for(const dz of [-.35,.35])add(x+dx,.4,z+dz,.12,.8,.12,'#806245');};
 const chair=(x,z)=>{add(x,.46,z,.55,.12,.55,'#9eae83');add(x,.9,z+.2,.55,.8,.1,'#aebd91');for(const dx of [-.2,.2])for(const dz of [-.2,.2])add(x+dx,.2,z+dz,.07,.45,.07,'#806a52');};
 const plant=(x,z,big=false)=>{add(x,.25,z,big?.75:.4,.5,big?.75:.4,'#b98b6b');objects.push({shape:'tree',x,y:.5,z,size:big?1.2:.7,color:'#84a875'});};
 const shelf=(x,z,w=2)=>{add(x,1.5,z,w,3,.55,'#9e7857');for(let row=0;row<4;row++){add(x,.4+row*.65,z-.05,w+.05,.08,.7,'#c5aa81');for(let i=0;i<8;i++)add(x-w/2+.15+i*w/8,.65+row*.65,z-.3,.12,.45,.24,['#799a8b','#b8a473','#aa8775','#8091aa','#b5b89a'][i%5]);}};
 if(kind==='library'){
  for(const x of [-4,-1.4,1.4,4])shelf(x,4.4,2);for(const x of [-3,3]){table(x,.6);chair(x-1.2,.6);chair(x+1.2,.6);add(x,1,.6,.5,.1,.4,'#d9e4bd');}plant(-4,-2,true);plant(4,-2,true);add(0,2.8,4,2,.3,.06,'#d3c096','知识与相遇');
 }else if(kind==='bakery'||kind==='cafe'){
  add(-3,1.4,3,2.5,2.8,1.8,'#9b806e');add(-3,1.25,2.04,1.6,.9,.1,'#3b302b');add(-3,1.2,1.95,1,.5,.04,'#e9a954');add(-3,2.9,3,.7,1.7,.7,'#8c877a');
  add(2,.9,3.4,4,1.8,1.2,'#ae8b61');add(2,1.86,3.4,4.3,.12,1.4,'#ead8b5');for(let i=0;i<6;i++)add(.6+i*.55,2,3.25,.38,.2,.5,'#d9aa66');shelf(4.7,0,1.1);
  if(kind==='cafe'){for(const x of [-2.5,2.5]){table(x,-.8);chair(x,-1.9);chair(x,.2);add(x,.99,-.8,.16,.18,.16,'#eee6d4');}plant(-4,-3,true);plant(4,-3,true);}else{table(0,-.2);for(let i=0;i<4;i++)add(-.6+i*.4,.99,-.2,.25,.15,.4,'#e8c786');add(-4,.65,-1,1.2,1.3,1,'#cbbb94','谷物与面粉');}
 }else if(kind==='workshop'){
  table(-2,1);table(2,1);for(let x=-4;x<5;x+=1.4){add(x,1.6,4.5,.7,3.2,.65,'#82978c');add(x,3.25,4.5,.8,.12,.8,'#b5c2aa');}
  add(-2,1.3,1,.8,.5,.5,'#6d837b');add(2,1.4,1,.35,.8,.5,'#b59a65');for(let i=0;i<5;i++)add(-3+i*.65,2.1,4.1,.08,.8,.12,'#d0ae71');add(3.8,.45,-2,1.5,.9,1.5,'#bd9b6c','工具与材料');plant(-4,-2);
 }else if(kind==='hall'){
  add(0,.18,3.5,8,.35,2.5,'#b4ad97');add(0,1,3.3,1.8,1.5,1,'#927b5a','公共讨论');add(0,2.5,4.7,5,1.6,.1,'#7e9785','议案与建设进度');for(const z of [-1,1])for(const x of [-3,-1,1,3])chair(x,z);plant(-4.5,3,true);plant(4.5,3,true);
 }else if(kind==='market'){
  const colors=['#a5b98a','#c1a0a0','#a49ab8'];for(let n=0;n<3;n++){const x=-3.4+n*3.4;add(x,.8,2,2.5,1.6,1.7,'#b9a17b');add(x,2.6,2,2.9,.2,2.1,colors[n]);for(const dx of [-1.1,1.1])add(x+dx,1.8,2,.09,2.8,.09,'#8d7e66');for(let i=0;i<6;i++)add(x-.8+(i%3)*.7,1.75,1.7+Math.floor(i/3)*.4,.45,.25,.3,['#e1bc7d','#9fb475','#bb937e'][n]);}add(-4,.4,-2,1.5,.8,1.5,'#b89d70');plant(4,-2,true);
  const stock=state.pantryStock||{bread:0,grain:0};
  add(0,.1,-1.2,2.8,.2,.9,'#a78c66');add(0,.85,-1.2,2.8,.12,.9,'#c3aa81');add(0,1.65,-1.2,2.8,.12,.9,'#c3aa81');
  for(const x of [-1.32,1.32])add(x,.85,-1.2,.12,1.7,.8,'#a78c66');
  add(0,2.15,-1.05,2.8,.5,.12,'#a7b991',`互助食柜 · 面包${stock.bread} / 谷物${stock.grain}`);
  for(let i=0;i<Math.min(6,stock.bread);i++)add(-1+i*.4,1.02,-1.2,.3,.23,.5,'#dbb77b');
  for(let i=0;i<Math.min(6,stock.grain);i++)add(-1+i*.4,.28,-1.2,.28,.23,.45,'#d3c292');
 }else if(kind==='house'||kind==='homes'||kind==='cabin'){
  add(-2.8,.45,2.1,2.5,.9,3.5,'#ac8e70');add(-2.8,1,2.2,2.35,.35,3.3,'#d7d7bd');add(-2.8,1.23,3.2,1.8,.2,.6,'#f1e8d3');add(-2.8,1.22,1.5,2.35,.12,1.8,'#98ada0');
  add(2.8,.65,2.9,2.3,1.3,1.1,'#a3b191');add(2.8,1.3,3.4,2.3,.6,.2,'#8a9e80');table(2,-.2);chair(3.3,-.2);add(2.8,1,4.7,3.8,2,.5,'#b3a58a');add(3,2.1,4.5,.8,.14,.6,'#d8cfb8');plant(-4,-3,true);plant(4,-3,true);add(0,.03,-.4,2.8,.04,2.3,'#c4bca0');
 }else if(kind==='farm'){
  for(let row=0;row<5;row++)for(let col=0;col<7;col++){const x=-4.5+col*1.4,z=-2+row*1.5;add(x,.12,z,1.1,.24,.8,'#a39165');objects.push({shape:'tree',x,y:.2,z,size:.35,color:row%2?'#9eba69':'#789d67'});}add(4,1.5,5,2,3,2,'#b7bfa1','温室水箱');
 }else if(kind==='ruins'){
  for(let i=0;i<7;i++){const angle=i*Math.PI*2/7;add(Math.cos(angle)*4,1.5+(i%3)*.2,Math.sin(angle)*4,1.1,3+(i%3)*.4,1,'#9baba0');}add(0,.2,0,3,.4,3,'#a7b6a2');plant(2,1,true);
 }else{
  add(0,.08,1,3.5,.15,2.4,kind==='spring'||kind==='square'?'#9dcac2':'#c7d4b1');for(const x of [-3,3]){add(x,.55,1,1.8,.25,.6,'#a98b66');plant(x,3,true);}for(let i=0;i<14;i++){const a=i*.78;objects.push({shape:'tree',x:Math.cos(a)*6,y:0,z:Math.sin(a)*6,size:kind==='garden'?.6:1.7,color:['#82a176','#a1b582','#749b7c'][i%3]});}
  if(kind==='camp'){add(1,1.1,4,3,2.2,2.7,'#c7a275');add(0,.2,0,1,.4,1,'#c79c6b','篝火营地');}if(kind==='lookout')add(0,1.5,4,5,3,2.5,'#ad9674','山野观景台');
 }
 return {kind,outdoor,objects,floor:outdoor?'#c2d1ac':kind==='workshop'?'#aeb9ad':'#ccb999',wall:kind==='library'?'#e7e5d6':'#e6deca',title:SCENE_NAMES[kind]||'生活空间'};
}
const shade=(hex,f)=>{const n=parseInt(hex.slice(1),16);return `rgb(${Math.min(255,((n>>16)&255)*f)},${Math.min(255,((n>>8)&255)*f)},${Math.min(255,(n&255)*f)})`;};
export class PerspectiveScene{
 constructor(ctx,width,height,camera){this.ctx=ctx;this.w=width;this.h=height;this.camera=camera;this.faces=[];this.labels=[];this.focal=width*.72;}
 transform([x,y,z]){const c=this.camera,dx=x-c.x,dz=z-c.z,dy=y-c.y,cs=Math.cos(c.yaw),sn=Math.sin(c.yaw),side=dx*cs-dz*sn,forward=dx*sn+dz*cs,cp=Math.cos(c.pitch||0),sp=Math.sin(c.pitch||0);return [side,dy*cp-forward*sp,dy*sp+forward*cp];}
 screen(point){const p=this.transform(point);return p[2]>.15?[this.w/2+p[0]/p[2]*this.focal,this.h*.5-p[1]/p[2]*this.focal,p[2]]:null;}
 polygon(points,color,ground=false){let p=points.map(v=>this.transform(v));const clipped=[];for(let i=0;i<p.length;i++){const a=p[i],b=p[(i+1)%p.length],ai=a[2]>=.15,bi=b[2]>=.15;if(ai)clipped.push(a);if(ai!==bi){const t=(.15-a[2])/(b[2]-a[2]);clipped.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,.15]);}}if(clipped.length<3)return;const projected=clipped.map(v=>[this.w/2+v[0]/v[2]*this.focal,this.h*.5-v[1]/v[2]*this.focal]);if(projected.every(v=>v[0]<-100)||projected.every(v=>v[0]>this.w+100)||projected.every(v=>v[1]<-100)||projected.every(v=>v[1]>this.h+100))return;this.faces.push({p:projected,color,depth:ground?1e5+clipped.reduce((s,v)=>s+v[2],0)/clipped.length:clipped.reduce((s,v)=>s+v[2],0)/clipped.length});}
 box(o){const {x,y,z,w,h,d,color}=o,x0=x-w/2,x1=x+w/2,z0=z-d/2,z1=z+d/2,y0=y-h/2,y1=y+h/2;this.polygon([[x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]],shade(color,1.12));this.polygon([[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0]],shade(color,.92));this.polygon([[x1,y0,z1],[x0,y0,z1],[x0,y1,z1],[x1,y1,z1]],shade(color,.82));this.polygon([[x0,y0,z1],[x0,y0,z0],[x0,y1,z0],[x0,y1,z1]],shade(color,.75));this.polygon([[x1,y0,z0],[x1,y0,z1],[x1,y1,z1],[x1,y1,z0]],color);if(o.label)this.labels.push({point:[x,y1+.25,z],text:o.label});}
 tree(x,z,size=1,y=0,color='#88a878'){this.box(box(x,y+size*.6,z,.25*size,1.2*size,.25*size,'#998166'));for(let level=0;level<2;level++){const bottom=y+size*(1+level*.6),top=bottom+size*1.7,rad=size*(1-level*.22);for(let i=0;i<7;i++){const a=i/7*Math.PI*2,b=(i+1)/7*Math.PI*2;this.polygon([[x+Math.cos(a)*rad,bottom,z+Math.sin(a)*rad],[x,top,z],[x+Math.cos(b)*rad,bottom,z+Math.sin(b)*rad]],shade(color,.85+(i%3)*.1));}}}
 person(x,z,resident,image){const foot=this.screen([x,0,z]),head=this.screen([x,1.85,z]);if(!foot||!head||foot[2]>65)return;const h=Math.min(this.h*1.4,Math.abs(foot[1]-head[1])),w=h*.72;this.faces.push({image,x:foot[0]-w/2,y:foot[1]-h,w,h,depth:foot[2],person:resident});this.labels.push({point:[x,2.05,z],text:resident.name});}
 finish(){const ctx=this.ctx;this.faces.sort((a,b)=>b.depth-a.depth);for(const f of this.faces){if(f.image){if(f.image.complete&&f.image.naturalWidth)ctx.drawImage(f.image,f.x,f.y,f.w,f.h);else{ctx.fillStyle='#9fb384';ctx.fillRect(f.x+f.w*.25,f.y,f.w*.5,f.h);}continue;}ctx.beginPath();f.p.forEach((v,i)=>i?ctx.lineTo(...v):ctx.moveTo(...v));ctx.closePath();ctx.fillStyle=f.color;ctx.fill();ctx.strokeStyle=f.color;ctx.lineWidth=.5;ctx.stroke();}for(const label of this.labels){const p=this.screen(label.point);if(!p||p[2]>28||p[0]<0||p[0]>this.w||p[1]<0||p[1]>this.h)continue;ctx.font=`${Math.max(10,Math.min(17,100/p[2]))}px "Microsoft YaHei",sans-serif`;ctx.textAlign='center';const width=ctx.measureText(label.text).width;ctx.fillStyle='rgba(248,250,237,.86)';ctx.fillRect(p[0]-width/2-5,p[1]-14,width+10,20);ctx.fillStyle='#3b5143';ctx.fillText(label.text,p[0],p[1]);}}
}
export function renderInterior(ctx,width,height,camera,site,state,people,images,time){const kind=site.interior||site.kind,layout=sceneLayout(kind,state),scene=new PerspectiveScene(ctx,width,height,camera);const sky=ctx.createLinearGradient(0,0,0,height);sky.addColorStop(0,layout.outdoor?'#adcbd0':'#dfddce');sky.addColorStop(1,layout.floor);ctx.fillStyle=sky;ctx.fillRect(0,0,width,height);scene.polygon([[-8,0,-8],[8,0,-8],[8,0,8],[-8,0,8]],layout.floor,true);
 if(!layout.outdoor){for(const [a,b] of [[[-6,0,6],[6,0,6]],[[6,0,6],[6,0,-6]],[[-6,0,-6],[-6,0,6]]])scene.polygon([a,b,[b[0],4.5,b[2]],[a[0],4.5,a[2]]],layout.wall);for(const x of [-3,3]){scene.box(box(x,2.5,5.92,1.8,1.5,.06,'#abcbd0'));scene.box(box(x,2.5,5.83,.08,1.6,.12,'#9e9278'));scene.box(box(x,2.5,5.81,1.9,.08,.12,'#9e9278'));}for(let x=-6;x<=6;x+=.75)scene.polygon([[x,.005,-6],[x+.025,.005,-6],[x+.025,.005,6],[x,.005,6]],'#b9a787',true);}
 for(const o of layout.objects)o.shape==='tree'?scene.tree(o.x,o.z,o.size,o.y,o.color):scene.box(o);
 for(const p of people){const angle=hash(state.landscape?.seed||'',0,0,p.id)*Math.PI*2,x=Math.cos(angle)*1.8,z=Math.sin(angle)*1.8;scene.person(x,z,p,images(p));}scene.finish();
 ctx.fillStyle='rgba(247,249,236,.88)';ctx.fillRect(18,18,Math.min(width-36,360),62);ctx.fillStyle='#38513e';ctx.font='bold 16px "Microsoft YaHei"';ctx.textAlign='left';ctx.fillText(site.name,32,43);ctx.font='11px "Microsoft YaHei"';ctx.fillStyle='#73816b';ctx.fillText(layout.title,32,63);
 if(kind==='bakery'||kind==='cafe'){const glow=scene.screen([-3,1.2,1.9]);if(glow){ctx.fillStyle=`rgba(255,190,91,${.09+Math.sin(time*.003)*.02})`;ctx.beginPath();ctx.arc(glow[0],glow[1],Math.min(140,100/glow[2]),0,Math.PI*2);ctx.fill();}}
 return layout.title;
}
export function outdoorBuilding(scene,site){const x=site.worldX*6,z=site.worldZ*6,kind=site.interior||site.kind;
 if(['square','garden','farm','grove','spring'].includes(kind)){scene.box(box(x,.12,z,7,.24,7,kind==='spring'||kind==='square'?'#a9cac1':'#b7cb91'));if(kind==='square'){scene.box(box(x,.65,z,2,1.3,2,'#d4d6ba'));scene.box(box(x,1.5,z,.4,1.5,.4,'#bdc9b5'));}else for(let i=0;i<5;i++)scene.tree(x+(i%3-1)*2,z+(Math.floor(i/3)-.5)*3,.8,0,'#86a879');}
 else{const color=({library:'#d2c3a1',workshop:'#a2b5aa',house:'#d8c2a6',cabin:'#ba9f7b',bakery:'#d7b79b',cafe:'#d5c2a0',hall:'#c0c8b9',market:'#c6b7d0',camp:'#c3a780',ruins:'#a2b4a7',lookout:'#b6aa8a'})[kind]||'#c3c5aa';scene.box(box(x,1.8,z,6.5,3.6,5.8,color));scene.box(box(x,3.8,z,7,.5,6.3,shade(color,.77)));for(const dx of [-2,2])scene.box(box(x+dx,2,z-2.94,1,1.2,.08,'#aecacc'));scene.box(box(x,.9,z-2.95,1.2,1.8,.12,'#8a816b'));}scene.labels.push({point:[x,4.7,z],text:site.name});
}
