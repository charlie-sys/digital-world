import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { WorldError, clean } from './world.mjs';

// Node BlockList matches IPv4 addresses against IPv4-mapped IPv6 ranges too.
// Keep families separate so blocking ::ffff:0:0/96 cannot block all public IPv4.
const blockedV4=new BlockList(),blockedV6=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]])blockedV4.addSubnet(ip,bits,'ipv4');
for(const [ip,bits] of [['::',128],['::1',128],['::ffff:0:0',96],['fc00::',7],['fe80::',10],['ff00::',8]])blockedV6.addSubnet(ip,bits,'ipv6');
export const privateAddress=ip=>isIP(ip)===4?blockedV4.check(ip,'ipv4'):isIP(ip)===6?blockedV6.check(ip,'ipv6'):true;

export function modelFailureReason(error){
  if(error instanceof WorldError)return error.message;
  const message=error?.message||'',code=error?.code||'';
  const status=message.match(/^Model HTTP (\d{3})$/)?.[1];
  if(status)return ({400:'模型接口返回 HTTP 400：请检查模型 ID 或 JSON 输出参数兼容性',401:'模型接口返回 HTTP 401：请检查 API 密钥是否有效',402:'模型接口返回 HTTP 402：请检查服务商账户余额',403:'模型接口返回 HTTP 403：当前密钥可能没有该模型的使用权限',404:'模型接口返回 HTTP 404：请检查 API 地址与模型 ID',429:'模型接口返回 HTTP 429：请求限流或额度不足'})[status]||`模型接口返回 HTTP ${status}，请稍后重试或检查服务商状态`;
  if(message==='Private model destination rejected')return '模型地址解析到了受限网络，已拦截；请检查 DNS、代理或本地模型接入设置';
  if(message==='HTTPS required')return '模型接口必须使用 HTTPS，本地模型需管理员启用本地接入';
  if(message==='Model timeout')return `模型请求超过 ${Math.ceil((error.timeoutMs||60000)/1000)} 秒未完成，可在个人模型配置中调整等待时间，或检查服务商响应速度`;
  if(['ETIMEDOUT','ESOCKETTIMEDOUT'].includes(code))return '模型网络连接超时，请检查网络或服务商状态';
  if(['ENOTFOUND','EAI_AGAIN'].includes(code))return '无法解析模型域名，请检查接口地址和 DNS 设置';
  if(['ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH'].includes(code))return '无法连接模型服务，请检查网络、代理或服务商状态';
  if(/CERT|TLS|SSL/.test(code))return '模型接口的 TLS 证书校验失败，请检查接口地址和证书';
  if(message==='Model response is not valid JSON')return '模型未返回有效 JSON，请检查 JSON 输出兼容性或输出是否被截断';
  if(message==='Model response too large')return '模型响应超过允许大小，请调整模型输出';
  return '模型服务请求未完成，请检查接口配置后重试';
}

export class Models {
  constructor(world,{keyPath,allowLocal=false,ollama=null}={}) {
    this.world=world;this.allowLocal=allowLocal;this.ollama=ollama;
    world.db.exec('CREATE TABLE IF NOT EXISTS model_settings(user_id TEXT PRIMARY KEY REFERENCES users(id),base TEXT NOT NULL,model TEXT NOT NULL,secret TEXT NOT NULL,updated TEXT NOT NULL)');
    if(!world.db.prepare('PRAGMA table_info(model_settings)').all().some(c=>c.name==='timeout_ms'))world.db.exec('ALTER TABLE model_settings ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 60000');
    const hasMailQueue=world.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_outbox'").get();
    const encryptedRows=world.db.prepare('SELECT count(*) n FROM model_settings').get().n+(hasMailQueue?world.db.prepare('SELECT count(*) n FROM recovery_outbox').get().n:0);
    if(keyPath&&!existsSync(keyPath)&&encryptedRows>0)throw new Error('Encryption key is missing. Restore model-encryption.key from the matching data backup.');
    if(keyPath){mkdirSync(dirname(keyPath),{recursive:true});try{writeFileSync(keyPath,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}this.key=readFileSync(keyPath);}else this.key=randomBytes(32);
    if(this.key.length!==32)throw new Error('Model encryption key must contain 32 bytes');
  }
  encrypt(userId,secret){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(userId));const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),encrypted].map(b=>b.toString('base64')).join('.');}
  decrypt(userId,secret){const [iv,tag,encrypted]=secret.split('.').map(v=>Buffer.from(v,'base64')),decipher=createDecipheriv('aes-256-gcm',this.key,iv);decipher.setAAD(Buffer.from(userId));decipher.setAuthTag(tag);return Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8');}
  public(userId){const r=this.world.db.prepare('SELECT base,model,updated,timeout_ms / 1000 AS timeoutSeconds FROM model_settings WHERE user_id=?').get(userId),pref=this.ollama?.preference(userId),provider=pref?.provider||'api';return {...(r||{base:'',model:'',timeoutSeconds:60}),provider,ollamaModel:pref?.local_model||'',localTimeoutSeconds:(pref?.timeout_ms||180000)/1000,apiConfigured:Boolean(r),keyConfigured:Boolean(r),configured:provider==='ollama'?this.ollama.ready(userId):Boolean(r),selectedModel:provider==='ollama'?pref.local_model:r?.model||null};}
  get(userId){if(this.ollama?.preference(userId)?.provider==='ollama')return this.ollama.configuration(userId);const r=this.world.db.prepare('SELECT * FROM model_settings WHERE user_id=?').get(userId);return r?{base:r.base,model:r.model,key:this.decrypt(userId,r.secret),revision:r.secret,timeoutMs:r.timeout_ms,updated:r.updated}:null;}
  isCurrent(userId,config){if(config.provider==='ollama')return Boolean(this.ollama?.isCurrent(userId,config));if(this.ollama?.preference(userId)?.provider==='ollama')return false;const r=this.world.db.prepare('SELECT base,model,secret,timeout_ms FROM model_settings WHERE user_id=?').get(userId);return Boolean(r&&r.base===config.base&&r.model===config.model&&r.secret===config.revision&&r.timeout_ms===config.timeoutMs);}
  forResident(resident){const binding=this.world.db.prepare('SELECT * FROM resident_model_assignments WHERE resident_id=?').get(resident.id);return binding?{...this.ollama.sharedConfiguration(binding.model),managedRevision:binding.revision}:this.get(resident.user_id);}
  currentForResident(resident,config){const binding=this.world.db.prepare('SELECT * FROM resident_model_assignments WHERE resident_id=?').get(resident.id);if(config.managedRevision){try{return Boolean(binding&&binding.revision===config.managedRevision&&this.ollama.sharedConfiguration(binding.model).revision===config.revision);}catch{return false;}}return !binding&&this.isCurrent(resident.user_id,config);}
  save(userId,{base,model,key,timeoutSeconds}){
    base=clean(base,500);model=clean(model,160);let url;
    try{url=new URL(base);}catch{throw new WorldError('请输入完整的模型 API 地址');}
    const hostname=url.hostname.replace(/^\[|\]$/g,'');
    if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol))throw new WorldError('接口地址必须为 HTTP(S)，不能包含账号、查询参数或片段');
    if(!this.allowLocal&&(url.protocol!=='https:'||hostname==='localhost'||hostname.endsWith('.localhost')||(isIP(hostname)&&privateAddress(hostname))))throw new WorldError('请使用公开的 HTTPS 模型地址；本地模型需管理员启用 ALLOW_LOCAL_MODEL_URLS');
    if(!model||/\s/.test(model))throw new WorldError('请填写有效的模型 ID，不要包含空白字符');
    const existing=this.world.db.prepare('SELECT secret,timeout_ms FROM model_settings WHERE user_id=?').get(userId);
    const seconds=timeoutSeconds===undefined?(existing?.timeout_ms||60000)/1000:Number(timeoutSeconds);
    if(!Number.isInteger(seconds)||seconds<10||seconds>180)throw new WorldError('模型等待时间需要为 10–180 秒的整数');
    if(key!==undefined&&typeof key!=='string')throw new WorldError('密钥格式无效');
    key=key?.trim();if(key&&(key.length>4096||/[\r\n\u0000]/.test(key)))throw new WorldError('密钥格式无效');
    if(!key&&!existing)throw new WorldError('首次配置时需要填写 API 密钥');
    const secret=key?this.encrypt(userId,key):existing.secret;
    this.world.db.prepare('INSERT INTO model_settings(user_id,base,model,secret,updated,timeout_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET base=excluded.base,model=excluded.model,secret=excluded.secret,updated=excluded.updated,timeout_ms=excluded.timeout_ms').run(userId,url.toString().replace(/\/$/,''),model,secret,new Date().toISOString(),seconds*1000);
    this.ollama?.useApi(userId);
    return this.public(userId);
  }
  delete(userId){this.world.transaction(()=>{this.world.db.prepare('DELETE FROM model_settings WHERE user_id=?').run(userId);if(this.ollama?.preference(userId)?.provider!=='ollama')this.world.db.prepare("UPDATE residents SET mode='manual' WHERE user_id=? AND mode='llm'").run(userId);this.world.touch();});return this.public(userId);}
  async complete(config,messages){
    if(config.provider==='ollama'){if(!this.ollama)throw new WorldError('本地模型适配器未启用',503);return this.ollama.complete(config,messages);}
    const timeoutMs=config.timeoutMs??60000;
    const url=new URL(`${config.base.replace(/\/$/,'')}/chat/completions`);
    const host=url.hostname.replace(/^\[|\]$/g,'');
    if(!this.allowLocal&&url.protocol!=='https:')throw new Error('HTTPS required');
    if(!this.allowLocal&&isIP(host)&&privateAddress(host))throw new Error('Private model destination rejected');
    const data=JSON.stringify({model:config.model,temperature:0.6,max_tokens:768,response_format:{type:'json_object'},messages});
    return new Promise((resolve,reject)=>{
      const req=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.key}`,'Content-Length':Buffer.byteLength(data)},lookup:(hostname,options,callback)=>{
        lookup(hostname,{all:true},(error,addresses)=>{
          if(error)return callback(error);
          if(!addresses.length||(!this.allowLocal&&addresses.some(a=>privateAddress(a.address))))return callback(new Error('Private model destination rejected'));
          // The checked address is used by the connection itself, preventing DNS rebinding.
          if(options?.all)callback(null,addresses);else callback(null,addresses[0].address,addresses[0].family);
        });
      }},res=>{
        let size=0;const chunks=[];
        res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){req.destroy(new Error('Model response too large'));return;}chunks.push(chunk);});
        res.on('error',reject);
        res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return reject(new Error(`Model HTTP ${res.statusCode}`));try{const result=JSON.parse(Buffer.concat(chunks).toString()),content=result.choices?.[0]?.message?.content;if(typeof content!=='string')throw new Error('Missing model content');resolve(JSON.parse(content));}catch{reject(new Error('Model response is not valid JSON'));}});
      });
      const timeout=setTimeout(()=>req.destroy(Object.assign(new Error('Model timeout'),{timeoutMs})),timeoutMs);
      req.on('error',reject);req.on('close',()=>clearTimeout(timeout));req.end(data);
    });
  }
}
