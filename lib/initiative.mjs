// Role opportunities use public facts and the resident's own conversations only.
const profiles=[
 ['farmer','种植者',/农|种植|植物|花|绿地/,['farm','square'],'关心粮食与绿化',['baker','builder']],
 ['baker','食物供应者',/面包|餐|厨|咖啡|食品/,['bakery','market'],'关心食物供应',['farmer','maker']],
 ['maker','制造者',/工具|制造|手艺|设计|能源/,['workshop','library'],'关心工具与生产',['builder','farmer']],
 ['librarian','知识分享者',/书|知识|阅读|教育|研究|记录/,['library','square'],'关心知识与经验',['maker','builder']],
 ['builder','建设者',/建设|设施|桥|建筑/,['hall','workshop'],'关心公共设施',['maker','farmer']]
];
export function roleInitiative(world,self,snapshot){
 const text=`${self.goal} ${self.personality}`;
 const row=profiles.find(p=>p[0]===self.job_id)||profiles.find(p=>p[2].test(text))||['neighbor','社区参与者',null,['square','library'],'关心邻里合作',[]];
 const reserved=/内向|安静|谨慎/.test(self.personality),interval=reserved?6:3;
 const recent=world.db.prepare("SELECT max(tick) tick FROM messages WHERE sender_id=? AND reply_to_id IS NULL").get(self.id).tick;
 const peers=snapshot.residents.filter(r=>r.id!==self.id&&!r.suspended&&!r.removed);
 const candidates=[];
 if(self.energy>=30&&self.hunger<65&&self.wellbeing.stress<70){
  for(const peer of peers){
   const last=world.db.prepare('SELECT max(tick) tick FROM messages WHERE sender_id=? AND recipient_id=?').get(self.id,peer.id).tick;
   const pending=world.db.prepare('SELECT m.id FROM messages m LEFT JOIN message_context c ON c.message_id=m.id WHERE m.sender_id=? AND m.recipient_id=? AND m.acknowledged=0 AND m.reply_to_id IS NULL AND coalesce(c.requires_reply,1)=1 AND m.tick>=?').get(self.id,peer.id,world.tick-12);
   if(pending||(last!==null&&world.tick-last<5))continue;
   const relation=world.effects.relationship(self.id,peer.id);if(relation.trust<-20)continue;
   const score=(row[5].includes(peer.job_id)?8:0)+(peer.location===self.location?3:0)+(peer.job_id===self.job_id?2:0)+Math.min(3,relation.trust/10);
   const grain=snapshot.goods.find(g=>g.id==='grain')?.stock||0,bread=snapshot.goods.find(g=>g.id==='bread')?.stock||0;
   const topic=row[0]==='baker'?`公共谷物库存 ${grain}、面包 ${bread}，想和你协调食物供应。`:row[0]==='farmer'?`公共谷物库存 ${grain}，想了解你的生产需求。`:row[0]==='maker'?'想了解你的工具需求，一起协调生产。':row[0]==='librarian'?'想收集你最近的工作经验，与邻居分享知识。':row[0]==='builder'?'想听听你对小镇公共设施的需求。':'想了解你当前最需要解决的问题，看看能否合作。';
   const pressure=(snapshot.environment||[]).find(p=>p.pollution>=10),projects=snapshot.community?.construction?.find(p=>p.status==='building');
   const subject=pressure?`我注意到${pressure.location}污染 ${pressure.pollution}/100，想与你商量如何分工清理。`:projects?`公共项目「${projects.title}」还有 ${projects.required-projects.progress} 工时，想了解你是否愿意参与。`:topic;
   candidates.push({score,kind:'social',reason:`${row[1]}与${peer.name}的角色协作`,action:'talk',parameters:{recipient_id:peer.id,content:`${peer.name}，我是${self.name}，${subject}我的目标是${self.goal.slice(0,55)}。`.slice(0,280)}});
  }
 }
 candidates.sort((a,b)=>b.score-a.score||a.parameters.recipient_id.localeCompare(b.parameters.recipient_id));
 const socialDue=recent===null||world.tick-recent>=interval;
 const opportunities=[];
 if(socialDue&&candidates.length){const chosen=candidates[0];opportunities.push(chosen);const invitations=world.interactions.invitations(self.id),peer=snapshot.residents.find(r=>r.id===chosen.parameters.recipient_id);if(!invitations.length&&peer&&self.energy>=40&&self.hunger<55){const pressure=(snapshot.environment||[]).find(p=>p.pollution>=10);opportunities.push({kind:'meeting',reason:'主动约见协作者，对方可明确拒绝',action:'invite',parameters:{recipient_id:peer.id,location:pressure?.location||row[3][0],purpose:pressure?'商量并参与现场环境清理':`${row[4]}，讨论实际需求与分工`}});}}
 const help=snapshot.residents.find(r=>r.id!==self.id&&!r.suspended&&r.location===self.location&&r.hunger>=75);
 if(help&&self.hunger<45&&self.energy>=30&&self.inventory.some(i=>i.item_id==='bread'&&i.quantity>=2)&&/合作|友善|温和|热心|互助|照顾/.test(self.personality+' '+self.goal))opportunities.unshift({kind:'help',reason:'同地点邻居饥饿，自己有额外面包',action:'give',parameters:{recipient_id:help.id,item_id:'bread',quantity:1}});
 const place=snapshot.environment?.find(p=>p.location===self.location);
 if(self.energy>=30&&self.hunger<65&&self.wellbeing.stress<70&&place?.pollution>=10&&!world.effects.cleanup(self))opportunities.unshift({kind:'environment',reason:`当前位置污染 ${place.pollution}/100，清理能改善环境`,action:'clean',parameters:{}});
 if(self.energy>=30&&self.hunger<65&&self.wellbeing.stress<70&&self.location!==row[3][0]&&world.tick%12===0)opportunities.push({kind:'explore',reason:`前往与${row[1]}目标相关的地点`,action:'move',parameters:{location:row[3][0]}});
 return {role:row[1],focus:row[4],personality:self.personality,style:reserved?'先观察，低频但具体地交流':'主动协作，围绕具体问题交流',socialDue,opportunities:opportunities.slice(0,3).map(({score,...o})=>o)};
}
