// Run with: node --env-file=.agent.env examples/external-agent.mjs
// Required: WORLD_AGENT_TOKEN, AGENT_LLM_KEY, AGENT_LLM_MODEL
// Optional: WORLD_URL, AGENT_LLM_BASE_URL
const {WORLD_AGENT_TOKEN,AGENT_LLM_KEY,AGENT_LLM_MODEL}=process.env;
if(!WORLD_AGENT_TOKEN||!AGENT_LLM_KEY||!AGENT_LLM_MODEL){console.error('Set WORLD_AGENT_TOKEN, AGENT_LLM_KEY, and AGENT_LLM_MODEL in your environment.');process.exit(1);}
const world=(process.env.WORLD_URL||'http://127.0.0.1:3000').replace(/\/$/,''),provider=(process.env.AGENT_LLM_BASE_URL||'https://api.openai.com/v1').replace(/\/$/,'');
const headers={Authorization:`Bearer ${WORLD_AGENT_TOKEN}`,'Content-Type':'application/json'};
let lastTick=-1;
console.log('External agent connected. Private resident context will be sent to your configured model provider. Ctrl+C to stop.');
while(true){
 try{
  const observationResponse=await fetch(`${world}/api/agent/observe`,{headers,signal:AbortSignal.timeout(10000)});
  if(!observationResponse.ok)throw new Error(`Observe HTTP ${observationResponse.status}`);
  const observation=await observationResponse.json();
  if(observation.self.mode!=='external')throw new Error('Please select external agent mode in the resident settings first.');
  if(observation.tick!==lastTick){
   const response=await fetch(`${provider}/chat/completions`,{method:'POST',signal:AbortSignal.timeout(60000),headers:{Authorization:`Bearer ${AGENT_LLM_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:AGENT_LLM_MODEL,max_tokens:768,response_format:{type:'json_object'},messages:[{role:'system',content:observation.systemPrompt},{role:'user',content:JSON.stringify({...observation,systemPrompt:undefined})}]})});
   if(!response.ok)throw new Error(`Model HTTP ${response.status}`);
   const result=await response.json(),decision=JSON.parse(result.choices[0].message.content);
   // A stable per-hour key makes uncertain HTTP retries safe. Repeated model decisions
   // in the same hour cannot accidentally become another billable world action.
   const action=await fetch(`${world}/api/actions`,{method:'POST',headers,signal:AbortSignal.timeout(10000),body:JSON.stringify({...decision,idempotency_key:`external:${observation.self.id}:${observation.tick}`})});
   const outcome=await action.json();console.log(`Hour ${observation.tick}:`,outcome.message||outcome.error);
   lastTick=observation.tick;
  }
 }catch(e){console.error('Agent:',e.message);}
 await new Promise(resolve=>setTimeout(resolve,6000));
}
