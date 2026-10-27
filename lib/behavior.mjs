import {createHash} from 'node:crypto';

const roles={farmer:['种植者',6,/农|种植|植物|绿地|田园/],baker:['食物供应者',5,/面包|烘焙|厨|餐|咖啡/],maker:['制造者',8,/工具|制造|手艺|设计|能源/],librarian:['知识分享者',9,/书|知识|阅读|教育|研究|记录/],builder:['建设者',8,/建设|设施|桥|建筑|房/]};
const has=(text,pattern)=>[...text.matchAll(new RegExp(pattern,'giu'))].some(m=>!/(?:不|并非|不是|不太|不喜欢|缺乏|\b(?:not|never)\s+)$/i.test(text.slice(0,m.index)));
export function personalityTraits(text=''){
 const diligent=has(text,'勤奋|勤劳|负责|责任心|自律|认真|守时|尽责|务实|踏实|专注|敬业|上进|勤勉|进取|diligent|conscientious'),relaxed=has(text,'懒|随性|拖延|散漫|悠闲|懈怠|摸鱼|lazy')||/不(?:太)?(?:勤奋|自律|勤劳)/.test(text);
 return {diligence:diligent?.95:relaxed?.4:.7,sociability:has(text,'内向|安静|寡言|独处|沉默|孤僻|慢热|文静|introvert')?.15:has(text,'外向|健谈|活泼|热情|开朗|善于沟通|善交际|合群|extrovert')?.9:.5,kindness:has(text,'自私|冷漠|利己|坏蛋|冷酷|冷血|凶残|小偷|盗贼|贪婪|敌意|刻薄|恶意|傲慢|selfish')?.15:has(text,'友善|合作|温和|热心|互助|照顾|善良|kind')?.9:.5,curiosity:has(text,'好奇|探索|冒险|创新|求知|创造|创意|钻研|curious')?.9:.5,caution:has(text,'谨慎|稳重|保守|理性|周到|细心|审慎|cautious')?.9:has(text,'冲动|鲁莽|reckless')?.15:.5};
}
export function routine(world,self){const traits=personalityTraits(self.personality),job=world.db.prepare('SELECT * FROM jobs WHERE id=?').get(self.job_id||''),start=roles[job?.id]?.[1]??9,hour=world.tick%24,working=hour>=start&&hour<start+8,night=hour>=22||hour<5,from=Math.floor(world.tick/24)*24,laborToday=world.db.prepare("SELECT count(*) n FROM society_work WHERE resident_id=? AND kind='labor' AND tick>=? AND tick<=?").get(self.id,from,world.tick).n,limit=traits.diligence>=.9?4:traits.diligence<=.4?2:3;
 return {role:roles[job?.id]?.[0]||'自由居民',phase:night?'night':job&&working?'work':'personal',start,end:start+8,laborToday,limit};
}
const roll=(id,tick,salt)=>createHash('sha256').update(`behavior-v1:${id}:${tick}:${salt}`).digest().readUInt32BE(0)/4294967296;
// Stable for the same resident/hour: observing or refreshing cannot reroll a
// preference. Eligibility is recomputed from current facts before execution.
export function selectWeighted(id,tick,pools){const active=pools.filter(p=>p.steps.length&&p.weight>0),total=active.reduce((s,p)=>s+p.weight,0);if(!total)return {selected:null,probabilities:{}};let draw=roll(id,tick,'category')*total,chosen=active.at(-1);for(const p of active){draw-=p.weight;if(draw<0){chosen=p;break;}}
 return {selected:{...chosen.steps[Math.floor(roll(id,tick,'step')*chosen.steps.length)],kind:chosen.kind},probabilities:Object.fromEntries(active.map(p=>[p.kind,Math.round(p.weight/total*1000)/10]))};}
export function behaviorPlan(world,self,snapshot,{initiative,community,landscape,interaction,careStep,coordination,allowedActions,validate}){
 const traits=personalityTraits(self.personality),schedule=routine(world,self),job=snapshot.jobs.find(j=>j.id===self.job_id),healthy=self.energy>=30&&self.hunger<65&&self.wellbeing.stress<70,done=world.db.prepare("SELECT 1 FROM society_work WHERE resident_id=? AND tick=? AND kind='labor'").get(self.id,world.tick),pools={duty:[],goal:[],social:[],care:[],rest:[]};
 const add=(kind,step,reason)=>{if(!step)return;const c=world.landscape.journey(self,step);if(schedule.phase==='night'&&traits.caution>=.8&&kind==='goal'&&c.action==='explore')return;if(done&&['work','company_work','contract_work','build_project','construct_building','gather'].includes(c.action))return;if(c.action==='build_project'&&snapshot.goods.find(g=>g.id==='tools').stock<1)return;if(allowedActions.includes(c.action)&&!validate(c)&&!pools[kind].some(v=>v.action===c.action&&JSON.stringify(v.parameters)===JSON.stringify(c.parameters)))pools[kind].push({...c,reason:reason||step.reason||'结合身份与当前事实行动'});};
 if(healthy&&!done&&schedule.laborToday<schedule.limit){
  for(const c of community.candidates.filter(c=>['contract_work','company_work','build_project','move'].includes(c.action)))add('duty',c);
  if(job&&snapshot.treasury>=job.wage-Math.floor(job.wage*snapshot.tax/100)&&(job.id!=='baker'||snapshot.goods.find(g=>g.id==='grain').stock>=2)&&!pools.duty.length)add('duty',self.location===job.location?{action:'work',parameters:{}}:{action:'move',parameters:{location:job.location}},`履行${job.title}职责，先到岗再实际劳动`);
  if(!job){const matches=Object.entries(roles).filter(([,v])=>v[2].test(self.goal)).map(([id])=>id),vacancies=snapshot.jobs.filter(j=>j.filled<j.capacity).sort((a,b)=>Number(matches.includes(b.id))-Number(matches.includes(a.id))||a.id.localeCompare(b.id));if(vacancies[0])add('duty',{action:'apply_job',parameters:{job_id:vacancies[0].id}},'按长期目标寻找有空缺的职业');}
 }
 if(healthy){
  for(let c of [...landscape.candidates,...community.candidates.filter(c=>!['contract_work','company_work','build_project','move'].includes(c.action))]){if(c.action==='plan_building'){const preferred=/书|阅览|知识/.test(self.goal)?'library':/咖啡|餐|面包/.test(self.goal)?'cafe':/绿地|花园|植物/.test(self.goal)?'garden':/工具|工坊|制造/.test(self.goal)?'workshop':'house',option=landscape.affordableBuildings.find(b=>b.kind===preferred);if(option)c={...c,parameters:{...c.parameters,kind:preferred,name:`${self.name}的${option.name}`.slice(0,40)}};}if(c.action==='create_company'&&self.balance<c.parameters.capital+(traits.caution>=.8?100:16))continue;add('goal',c,'推进本人长期目标与已有建设');}
  for(const c of initiative.opportunities){if(['social','meeting'].includes(c.kind))add('social',c);else if(['help','environment'].includes(c.kind))add('care',c);else add('goal',c);}
  if(interaction.reply)add('social',interaction.reply);if(interaction.next){let step=interaction.next;if(step.action==='respond_invitation')step={...step,parameters:{...step.parameters,accept:roll(self.id,world.tick,'invitation')<(.2+.65*traits.sociability)*(schedule.phase==='work'?.5:1)}};add('social',step);}
  if(careStep?.action==='donate_food')add('care',careStep,'有余粮时照顾社区');
  if(coordination?.next&&!coordination.current)add('care',coordination.next,'主动承担社区需要');
  if(job&&self.location!==job.location&&schedule.phase!=='work'&&traits.curiosity<.8&&self.location!=='homes')add('goal',{action:'move',parameters:{location:'homes'}},'下班后回到社区生活');
 }
 if(self.energy<90||self.wellbeing.stress>=30)add('rest',{action:'rest',parameters:{}},schedule.phase==='night'?'夜间恢复身体状态':'适当休息，避免连续透支');
 // Off-duty interests remain meaningful even when there is no active building
 // project; facts-only sharing does not invent learning or completed research.
 if(healthy&&schedule.phase!=='work'&&!pools.goal.length){const goalPlace=/书|知识|研究|阅读/.test(self.goal)?'library':/植物|绿地|花|农/.test(self.goal)?'farm':/建设|桥|公共/.test(self.goal)?'hall':traits.sociability<.3?'library':'square';if(self.location!==goalPlace&&(schedule.phase!=='night'||traits.caution<.8))add('goal',{action:'move',parameters:{location:goalPlace}},'空闲时前往符合兴趣的公共空间');}
 if(healthy&&/植物|种植|绿地|绿化/.test(self.goal))add('goal',{action:'plant_tree',parameters:{}},'按绿化目标种下本人实际拥有的种子');
 if(!pools.goal.length)add('goal',{action:'observe',parameters:{}},schedule.phase==='night'?'夜间留在原地安静观察，不虚构工作或学习成果':'观察当前场所，为下一步行动留出空间');
 const dutyWeight=schedule.phase==='work'||!job&&schedule.phase!=='night'?40+100*traits.diligence:schedule.phase!=='night'&&self.balance<16?20:0;
 const result=selectWeighted(self.id,world.tick,[{kind:'duty',weight:dutyWeight,steps:pools.duty},{kind:'goal',weight:6+10*traits.curiosity,steps:pools.goal},{kind:'social',weight:3+20*traits.sociability,steps:pools.social},{kind:'care',weight:2+12*traits.kindness,steps:pools.care},{kind:'rest',weight:schedule.phase==='night'?100:schedule.phase==='work'?traits.diligence<=.4?25:5:25,steps:pools.rest}]);
 const constraints=[];if(!healthy)constraints.push('先恢复体力、饮食或压力状态');if(done)constraints.push('本小时已投入劳动');if(schedule.laborToday>=schedule.limit)constraints.push('今日常规劳动已足够，给个人生活留出时间');if(schedule.phase!=='work'&&job)constraints.push('当前不在职业时段');if(job&&snapshot.treasury<job.wage-Math.floor(job.wage*snapshot.tax/100))constraints.push('公共财政暂不足以支付岗位工资');if(job?.id==='baker'&&snapshot.goods.find(g=>g.id==='grain').stock<2)constraints.push('面包房缺少真实谷物原料');
 return {schedule,traits,...result,constraints,priority:'weighted'};
}
