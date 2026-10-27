export class MapCamera{
 constructor(){this.scale=1;this.x=0;this.y=0;}
 transform(){return `translate(${500*(1-this.scale)+this.x} ${290*(1-this.scale)+this.y}) scale(${this.scale})`;}
 zoom(factor){this.scale=Math.max(.6,Math.min(4,this.scale*factor));this.bound();}
 pan(x,y){this.x+=x;this.y+=y;this.bound();}
 bound(){this.x=Math.max(-600*this.scale,Math.min(600*this.scale,this.x));this.y=Math.max(-350*this.scale,Math.min(350*this.scale,this.y));}
 reset(){this.scale=1;this.x=0;this.y=0;}
}
export function installMapCamera({camera,mapHtml,sidebarHtml,selectResident,onClose}){
 let root=null,drag=null,suppress=false,focus=null,signature='',previousOverflow='',previousFocus=null;
 const paint=()=>document.querySelectorAll('[data-map-camera]').forEach(g=>g.setAttribute('transform',camera.transform()));
 const update=()=>{if(root){const html=sidebarHtml(focus);if(signature!==html&&!document.activeElement?.matches('[data-map-resident-select]')){root.querySelector('.map-screen-status').innerHTML=html;signature=html;}}};
 function close(){if(!root)return;const old=root;root=null;old.remove();document.body.style.overflow=previousOverflow;if(document.fullscreenElement===old)document.exitFullscreen().catch(()=>{});previousFocus?.focus();onClose?.();}
 function open(){if(root)return;previousFocus=document.activeElement;previousOverflow=document.body.style.overflow;root=document.createElement('section');root.className='map-screen';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','全屏世界地图与实时状态');root.innerHTML=`<header><div><strong>晨曦镇 · 全屏世界</strong><small>拖动地图 · 滚轮缩放 · 方向键移动 · Esc退出</small></div><button class="button secondary" data-map-close>退出全屏</button></header><div class="map-screen-body"><div class="map-screen-stage">${mapHtml()}</div><aside class="map-screen-status" aria-label="实时世界状态"></aside></div>`;document.body.append(root);document.body.style.overflow='hidden';signature='';update();paint();root.querySelector('[data-map-close]').focus();if(root.requestFullscreen)root.requestFullscreen().catch(()=>{});}
 document.addEventListener('click',event=>{
  if(suppress&&event.target.closest('.map-area')){event.preventDefault();event.stopImmediatePropagation();suppress=false;return;}
  if(event.target.closest('[data-map-close]')){event.preventDefault();event.stopImmediatePropagation();close();return;}
  if(root&&root.contains(event.target)){const person=event.target.closest('.digital-resident');if(person){event.preventDefault();event.stopImmediatePropagation();focus=person.dataset.resident;selectResident(focus);update();}}
 },true);
 document.addEventListener('pointerdown',event=>{const area=event.target.closest('.map-area');if(!area||event.button!==0||event.target.closest('button,input,select'))return;drag={area,id:event.pointerId,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false};});
 document.addEventListener('pointermove',event=>{if(!drag||event.pointerId!==drag.id)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(!drag.moved&&Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)<5)return;if(!drag.area.isConnected){drag=null;return;}if(!drag.moved){drag.moved=true;drag.area.setPointerCapture(event.pointerId);drag.area.classList.add('dragging');}const rect=drag.area.querySelector('svg').getBoundingClientRect(),ratio=Math.max(1000/rect.width,580/rect.height);camera.pan(dx*ratio,dy*ratio);drag.x=event.clientX;drag.y=event.clientY;paint();});
 const release=()=>{if(!drag)return;if(drag.moved){suppress=true;setTimeout(()=>{suppress=false;},250);}drag.area.classList.remove('dragging');if(drag.area.hasPointerCapture?.(drag.id))drag.area.releasePointerCapture(drag.id);drag=null;};
 document.addEventListener('pointerup',release);document.addEventListener('pointercancel',release);
 document.addEventListener('wheel',event=>{if(!event.target.closest('.map-area'))return;event.preventDefault();camera.zoom(event.deltaY<0?1.12:1/1.12);paint();},{passive:false});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&root){close();return;}if(!event.target.closest('.map-area')||event.target.closest('button,input,select'))return;const deltas={ArrowLeft:[50,0],ArrowRight:[-50,0],ArrowUp:[0,50],ArrowDown:[0,-50]};if(deltas[event.key]){event.preventDefault();camera.pan(...deltas[event.key]);paint();}if(['+','=','-','0'].includes(event.key)){event.preventDefault();if(event.key==='0')camera.reset();else camera.zoom(event.key==='-'?1/1.2:1.2);paint();}});
 document.addEventListener('fullscreenchange',()=>{if(root&&!document.fullscreenElement)close();});
 document.addEventListener('change',event=>{if(root&&event.target.matches('[data-map-resident-select]')){focus=event.target.value;selectResident(focus);update();}});
 return {open,close,zoom(factor){camera.zoom(factor);paint();},reset(){camera.reset();paint();},update,sync(){if(root){const target=root.querySelector('.digital-residents'),template=document.createElement('template');template.innerHTML=mapHtml();target.innerHTML=template.content.querySelector('.digital-residents').innerHTML;}update();paint();},get isOpen(){return Boolean(root);}};
}
