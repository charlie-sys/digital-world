import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { normalizeEmail, smtpMailer } from '../lib/recovery.mjs';

function setup(options={}){const messages=[];const app=createApp({mailer:{send:async message=>messages.push(message)},appUrl:'https://world.example',...options});return {...app,messages,stop(){app.recovery.close();app.server.close();app.world.close();}};}
const user=app=>app.world.register('recover-user','old-password-123');
const token=message=>message.text.match(/#(?:verify-email|reset-password)=([a-f0-9]{64})/)[1];
async function bind(app,id,email='Owner@Example.com'){app.recovery.bind(id,{email,password:'old-password-123'});await app.recovery.drain();return app.recovery.verify({token:token(app.messages.at(-1))});}

test('binding requires current password, mailbox proof, expiring one-use tokens and no secret output',async()=>{
 const app=setup();try{const {user:u}=user(app);assert.throws(()=>app.recovery.bind(u.id,{email:'owner@example.com',password:'bad'}),/当前密码/);
  const result=app.recovery.bind(u.id,{email:'Owner@Example.com',password:'old-password-123'});assert.ok(!JSON.stringify(result).includes('token'));assert.equal(app.recovery.state(u.id).verified,false);
  assert.equal(app.messages.length,0);await app.recovery.drain();assert.equal(app.messages[0].to,'owner@example.com');const raw=token(app.messages[0]);
  const stored=app.world.db.prepare('SELECT * FROM recovery_tokens').get();assert.notEqual(stored.token_hash,raw);assert.ok(!JSON.stringify(app.world.snapshot(u.id)).includes(raw));
  app.recovery.verify({token:raw});assert.deepEqual(app.recovery.state(u.id),{email:'o***@example.com',verified:true,pendingEmail:null,mailConfigured:true});assert.throws(()=>app.recovery.verify({token:raw}),/链接无效/);
 }finally{app.stop();}
});

test('forgot password is generic, ignores unverified addresses and sends only to verified mailboxes',async()=>{
 const app=setup();try{const {user:u}=user(app);app.recovery.bind(u.id,{email:'owner@example.com',password:'old-password-123'});
  const known=app.recovery.forgot({email:'owner@example.com'}),unknown=app.recovery.forgot({email:'unknown@example.com'});assert.deepEqual(known,unknown);assert.equal(app.world.db.prepare("SELECT count(*) n FROM recovery_tokens WHERE kind='reset'").get().n,0);
  await app.recovery.drain();app.recovery.verify({token:token(app.messages[0])});app.recovery.now=()=>Date.now()+61000;
  assert.deepEqual(app.recovery.forgot({email:'OWNER@EXAMPLE.COM'}),unknown);assert.deepEqual(app.recovery.forgot({email:'owner@example.com'}),unknown);await app.recovery.drain();assert.equal(app.messages.length,2);assert.equal(app.messages[1].to,'owner@example.com');
 }finally{app.stop();}
});

test('password reset revokes sessions and agent tokens, preserves assets and model config',async()=>{
 const app=setup();try{const login=user(app),u=login.user,r=app.world.join(u.id,{name:'找回居民',goal:'维护图书馆'});app.models.save(u.id,{base:'https://model.example/v1',model:'m',key:'private-model-key'});const agent=app.world.issueToken(r.id);await bind(app,u.id);
  app.recovery.forgot({email:'owner@example.com'});await app.recovery.drain();const raw=token(app.messages.at(-1));assert.throws(()=>app.recovery.reset({token:raw,password:'short'}),/8–128/);
  app.recovery.reset({token:raw,password:'new-password-123'});assert.equal(app.world.authenticate(login.token),undefined);assert.equal(app.world.tokenResident(agent),undefined);assert.throws(()=>app.world.login(u.username,'old-password-123'),/密码/);assert.equal(app.world.login(u.username,'new-password-123').user.id,u.id);assert.equal(app.world.resident(r.id).balance,200);assert.equal(app.models.get(u.id).key,'private-model-key');assert.throws(()=>app.recovery.reset({token:raw,password:'another-password'}),/链接无效/);
 }finally{app.stop();}
});

test('expired, cross-purpose and superseded recovery links are rejected',async()=>{
 const app=setup();try{const {user:u}=user(app);let now=Date.now();app.recovery.now=()=>now;app.recovery.bind(u.id,{email:'owner@example.com',password:'old-password-123'});await app.recovery.drain();const first=token(app.messages[0]);assert.throws(()=>app.recovery.reset({token:first,password:'new-password-123'}),/链接无效/);
  now+=61000;app.recovery.bind(u.id,{email:'owner@example.com',password:'old-password-123'});await app.recovery.drain();const second=token(app.messages[1]);assert.throws(()=>app.recovery.verify({token:first}),/链接无效/);now+=30*60000;assert.throws(()=>app.recovery.verify({token:second}),/链接无效/);
 }finally{app.stop();}
});

test('changing a mailbox needs proof, keeps old address until verified and invalidates old reset links',async()=>{
 const app=setup();try{const {user:u}=user(app);await bind(app,u.id);app.recovery.forgot({email:'owner@example.com'});await app.recovery.drain();const oldReset=token(app.messages.at(-1));app.recovery.now=()=>Date.now()+61000;
  app.recovery.bind(u.id,{email:'new@example.com',password:'old-password-123'});assert.equal(app.recovery.state(u.id).email,'o***@example.com');await app.recovery.drain();app.recovery.verify({token:token(app.messages.at(-1))});assert.equal(app.recovery.state(u.id).email,'n***@example.com');assert.throws(()=>app.recovery.reset({token:oldReset,password:'new-password-123'}),/链接无效/);
  const other=app.world.register('second-user','old-password-123').user;app.recovery.bind(other.id,{email:'new@example.com',password:'old-password-123'});await app.recovery.drain();assert.throws(()=>app.recovery.verify({token:token(app.messages.at(-1))}),/无法绑定/);
 }finally{app.stop();}
});

test('delivery retries are bounded; stored outbox messages are encrypted',async()=>{
 let attempts=0;const app=setup({mailer:{send:async()=>{attempts++;throw new Error('smtp credential must not leak');}}});try{const {user:u}=user(app);let now=Date.now();app.recovery.now=()=>now;app.recovery.bind(u.id,{email:'owner@example.com',password:'old-password-123'});
  const rows=JSON.stringify(app.world.db.prepare('SELECT * FROM recovery_outbox').all());assert.ok(!rows.includes('owner@example.com')&&!rows.includes('verify-email'));
  await app.recovery.drain();assert.equal(attempts,1);await app.recovery.drain();assert.equal(attempts,1);now+=60000;await app.recovery.drain();now+=60000;await app.recovery.drain();assert.equal(attempts,3);assert.equal(app.world.db.prepare('SELECT count(*) n FROM recovery_outbox').get().n,0);assert.equal(app.recovery.state(u.id).pendingEmail,null);
 }finally{app.stop();}
});

test('queued verification mail and verified addresses persist across restarts',async()=>{
 const database=join(mkdtempSync(join(tmpdir(),'morrow-email-')),'world.sqlite'),a=setup({database});const {user:u}=user(a);a.recovery.bind(u.id,{email:'owner@example.com',password:'old-password-123'});a.stop();
 const b=setup({database});try{await b.recovery.drain();assert.equal(b.messages.length,1);b.recovery.verify({token:token(b.messages[0])});assert.equal(b.recovery.state(u.id).verified,true);}finally{b.stop();}
});

test('missing SMTP is explicit and email/APP_URL validation rejects unsafe inputs',()=>{
 const app=setup({mailer:null});try{const {user:u}=user(app);assert.throws(()=>app.recovery.bind(u.id,{email:'owner@example.com',password:'old-password-123'}),/尚未配置/);assert.throws(()=>app.recovery.forgot({email:'owner@example.com'}),/尚未配置/);assert.equal(smtpMailer({}),null);for(const email of ['bad','a@example.com\r\nBcc:x@example.com','a@localhost'])assert.throws(()=>normalizeEmail(email));assert.equal(normalizeEmail(' Owner@Example.com '),'owner@example.com');}finally{app.stop();}
});

test('HTTP email binding and reset require proof, hide other users email and reject CSRF',async()=>{
 const app=setup();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 const req=(path,body,cookie,extra={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  const r=await req('/api/register',{username:'http-email-user',password:'old-password-123'}),cookie=r.headers.get('set-cookie').split(';')[0];assert.equal((await req('/api/account/email')).status,401);
  assert.equal((await req('/api/account/email',{email:'owner@example.com',password:'old-password-123'},cookie,{Origin:'https://evil.example'})).status,403);
  assert.equal((await req('/api/account/email',{email:'owner@example.com',password:'old-password-123'},cookie)).status,200);await app.recovery.drain();const proof=token(app.messages.at(-1));assert.equal((await req('/api/account/email/verify',{token:proof})).status,200);
  const publicState=await (await req('/api/world')).json();assert.equal(publicState.accountSecurity,null);assert.ok(!JSON.stringify(publicState).includes('owner@example.com'));
  const known=await (await req('/api/password/forgot',{email:'owner@example.com'})).json(),unknown=await (await req('/api/password/forgot',{email:'unknown@example.com'})).json();assert.deepEqual(known,unknown);await app.recovery.drain();const reset=token(app.messages.at(-1));
  const result=await req('/api/password/reset',{token:reset,password:'new-password-123'});assert.equal(result.status,200);assert.match(result.headers.get('set-cookie'),/Max-Age=0/);assert.equal((await req('/api/account/email',undefined,cookie)).status,401);assert.equal((await req('/api/password/reset',{token:reset,password:'other-password'})).status,400);
 }finally{await new Promise(r=>app.server.close(r));app.world.close();}
});
