import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { hash, WorldError } from './world.mjs';

export function normalizeEmail(value){
  if(typeof value!=='string')throw new WorldError('请输入有效的邮箱地址');
  const email=value.trim().toLowerCase();
  if(email.length>254||! /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email))throw new WorldError('请输入有效的邮箱地址');
  return email;
}
const masked=email=>email?`${email[0]}***@${email.split('@')[1]}`:null;
export function smtpMailer(env=process.env){
  if(!env.SMTP_HOST||!env.SMTP_FROM||!env.APP_URL)return null;
  const port=Number(env.SMTP_PORT||465),secure=env.SMTP_SECURE===undefined?port===465:env.SMTP_SECURE==='true';
  const transport=nodemailer.createTransport({host:env.SMTP_HOST,port,secure,requireTLS:!secure,auth:env.SMTP_USER?{user:env.SMTP_USER,pass:env.SMTP_PASS}:undefined,connectionTimeout:15000,greetingTimeout:10000,socketTimeout:20000,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true});
  return {send:async message=>{const result=await transport.sendMail({from:env.SMTP_FROM,...message});if(!result.accepted?.length)throw new Error('SMTP recipient not accepted');},close:()=>transport.close()};
}

export class Recovery {
  constructor(world,models,{mailer=null,appUrl,now=Date.now}={}){
    this.world=world;this.models=models;this.mailer=mailer;this.now=now;this.stopped=false;this.sending=false;
    if(appUrl){const url=new URL(appUrl);if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['http:','https:'].includes(url.protocol))throw new Error('APP_URL must be an HTTP(S) origin without a path, credentials, query or fragment');if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Public APP_URL requires HTTPS');this.appUrl=url.origin;}
    world.db.exec(`CREATE TABLE IF NOT EXISTS account_emails(user_id TEXT PRIMARY KEY REFERENCES users(id),email TEXT UNIQUE NOT NULL,verified_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL CHECK(kind IN ('bind','reset')),email TEXT NOT NULL,expires INTEGER NOT NULL,credential_hash TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS recovery_user_kind ON recovery_tokens(user_id,kind);
      CREATE TABLE IF NOT EXISTS recovery_outbox(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),token_hash TEXT NOT NULL REFERENCES recovery_tokens(token_hash) ON DELETE CASCADE,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery_cooldowns(key TEXT PRIMARY KEY,until INTEGER NOT NULL);`);
    world.db.prepare("UPDATE recovery_outbox SET status='queued' WHERE status='sending'").run();
    this.timer=setInterval(()=>this.drain().catch(()=>{}),5000);this.timer.unref();
  }
  get configured(){return Boolean(this.mailer&&this.appUrl);}
  state(userId){const email=this.world.db.prepare('SELECT email FROM account_emails WHERE user_id=?').get(userId)?.email;const pending=this.world.db.prepare("SELECT email FROM recovery_tokens WHERE user_id=? AND kind='bind' AND expires>? ORDER BY created DESC LIMIT 1").get(userId,this.now())?.email;return {email:masked(email),verified:Boolean(email),pendingEmail:masked(pending),mailConfigured:this.configured};}
  requireMail(){if(!this.configured)throw new WorldError('邮件服务尚未配置，请管理员设置 SMTP 与 APP_URL 后重启服务',503);}
  password(userId,password){const user=this.world.db.prepare('SELECT * FROM users WHERE id=?').get(userId);if(typeof password!=='string'||password.length>128||!user)throw new WorldError('当前密码不正确',403);const [salt,digest]=user.password.split(':');if(!timingSafeEqual(scryptSync(password,salt,64),Buffer.from(digest,'hex')))throw new WorldError('当前密码不正确',403);return user;}
  cooldown(key,silent=false){const until=this.world.db.prepare('SELECT until FROM recovery_cooldowns WHERE key=?').get(key)?.until;if(until>this.now()){if(silent)return false;throw new WorldError('请等待 60 秒后再发送邮件',429);}this.world.db.prepare('INSERT INTO recovery_cooldowns VALUES(?,?) ON CONFLICT(key) DO UPDATE SET until=excluded.until').run(key,this.now()+60000);return true;}
  queue(user,kind,email){
    const token=randomBytes(32).toString('hex'),tokenHash=hash(token),expires=this.now()+(kind==='bind'?30:15)*60000;
    this.world.db.prepare('DELETE FROM recovery_tokens WHERE user_id=? AND kind=?').run(user.id,kind);
    this.world.db.prepare('INSERT INTO recovery_tokens VALUES(?,?,?,?,?,?,?)').run(tokenHash,user.id,kind,email,expires,hash(user.password),this.now());
    const link=`${this.appUrl}/#${kind==='bind'?'verify-email':'reset-password'}=${token}`;
    const message={to:email,subject:kind==='bind'?'MORROW · 验证你的绑定邮箱':'MORROW · 重置账号密码',text:kind==='bind'?`你申请将此邮箱绑定到 MORROW 晨曦镇账号。请打开下面的链接，并在页面中确认绑定（30 分钟有效）：\n\n${link}\n\n如果不是你本人申请，请忽略此邮件。`:`你申请重置 MORROW 晨曦镇账号的密码。请打开下面的链接设置新密码（15 分钟有效）：\n\n${link}\n\n如果不是你本人申请，请忽略此邮件；现有密码不会改变。`};
    this.world.db.prepare("INSERT INTO recovery_outbox(id,user_id,token_hash,payload,status,next_attempt) VALUES(?,?,?,?,'queued',?)").run(randomUUID(),user.id,tokenHash,this.models.encrypt(user.id,JSON.stringify(message)),this.now());
  }
  bind(userId,{email,password}){this.requireMail();email=normalizeEmail(email);const user=this.password(userId,password);this.world.transaction(()=>{this.cooldown(`bind:${userId}`);this.queue(user,'bind',email);});return {ok:true,message:'验证邮件已加入发送队列，请前往邮箱打开链接确认。'};}
  forgot({email}){
    this.requireMail();email=normalizeEmail(email);
    // Same response and same queued delivery path for registered and unknown addresses.
    this.world.transaction(()=>{if(!this.cooldown(`reset:${hash(email)}`,true))return;const user=this.world.db.prepare('SELECT u.* FROM users u JOIN account_emails e ON e.user_id=u.id WHERE e.email=?').get(email);if(user)this.queue(user,'reset',email);});
    return {ok:true,message:'如果该邮箱已绑定账号，系统将发送密码重置邮件，请查收邮箱及垃圾邮件。'};
  }
  valid(token,kind){if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw new WorldError('链接无效或已过期，请重新申请');const row=this.world.db.prepare('SELECT t.*,u.password FROM recovery_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.kind=? AND t.expires>?').get(hash(token),kind,this.now());if(!row||row.credential_hash!==hash(row.password))throw new WorldError('链接无效或已过期，请重新申请');return row;}
  verify({token}){return this.world.transaction(()=>{const r=this.valid(token,'bind');const taken=this.world.db.prepare('SELECT user_id FROM account_emails WHERE email=?').get(r.email);if(taken&&taken.user_id!==r.user_id)throw new WorldError('该邮箱无法绑定，请使用其他邮箱');this.world.db.prepare('INSERT INTO account_emails VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,verified_at=excluded.verified_at').run(r.user_id,r.email,this.now());this.world.db.prepare('DELETE FROM recovery_tokens WHERE user_id=?').run(r.user_id);return {ok:true,message:'邮箱绑定成功，现在可以通过此邮箱找回密码。'};});}
  reset({token,password}){
    if(typeof password!=='string'||password.length<8||password.length>128)throw new WorldError('新密码需要 8–128 个字符');
    return this.world.transaction(()=>{const r=this.valid(token,'reset');const email=this.world.db.prepare('SELECT email FROM account_emails WHERE user_id=?').get(r.user_id)?.email;if(email!==r.email)throw new WorldError('链接无效或已过期，请重新申请');const salt=randomBytes(16).toString('hex');this.world.db.prepare('UPDATE users SET password=? WHERE id=?').run(`${salt}:${scryptSync(password,salt,64).toString('hex')}`,r.user_id);this.world.db.prepare('DELETE FROM sessions WHERE user_id=?').run(r.user_id);const resident=this.world.residentFor(r.user_id);if(resident)this.world.db.prepare('DELETE FROM agent_tokens WHERE resident_id=?').run(resident.id);this.world.db.prepare('DELETE FROM recovery_tokens WHERE user_id=?').run(r.user_id);return {ok:true,message:'密码已重置，请使用新密码登录。原登录会话和代理令牌已撤销。'};});
  }
  async drain(){
    if(this.stopped||this.sending||!this.configured)return;this.sending=true;
    try{
      this.world.db.prepare('DELETE FROM recovery_tokens WHERE expires<=?').run(this.now());
      this.world.db.prepare('DELETE FROM recovery_cooldowns WHERE until<=?').run(this.now());
      const rows=this.world.db.prepare("SELECT * FROM recovery_outbox WHERE status='queued' AND next_attempt<=? LIMIT 5").all(this.now());
      for(const row of rows){if(this.stopped)break;this.world.db.prepare("UPDATE recovery_outbox SET status='sending' WHERE id=?").run(row.id);try{const message=JSON.parse(this.models.decrypt(row.user_id,row.payload));await this.mailer.send(message);if(!this.stopped)this.world.db.prepare('DELETE FROM recovery_outbox WHERE id=?').run(row.id);}catch{if(!this.stopped){if(row.attempts>=2)this.world.db.prepare('DELETE FROM recovery_tokens WHERE token_hash=?').run(row.token_hash);else this.world.db.prepare("UPDATE recovery_outbox SET status='queued',attempts=attempts+1,next_attempt=? WHERE id=?").run(this.now()+60000,row.id);}}}
    }finally{this.sending=false;}
  }
  close(){this.stopped=true;clearInterval(this.timer);this.mailer?.close?.();}
}
