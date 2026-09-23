import assert from 'node:assert/strict';
import {test} from 'node:test';
import express from 'express';
import {createAdmin, isEditable, updatedSpec, serviceDetail} from '../admin.mjs';
import {newSecret, secretAttachments} from '../secrets.mjs';

const origin = 'https://admin.example.com', password = 'a-long-shared-test-password';
const service = {ID:'abc123',Version:{Index:7},Spec:{Name:'example_faas',Labels:{keep:'yes'},Mode:{Replicated:{Replicas:1}},TaskTemplate:{ContainerSpec:{Image:'example:latest',Env:['A=old','MULTI=line1\nline2'],Secrets:[{SecretID:'keep',SecretName:'existing',File:{Name:'existing',UID:'0',GID:'0',Mode:256}}]},Networks:[{Target:'network'}],RestartPolicy:{Condition:'any',Delay:5000000000},Resources:{Reservations:{MemoryBytes:1000}}}}};
async function setup(t) {
  const calls = []; let clock = Date.now();
  const control = structuredClone(service); control.ID = 'control'; control.Spec.Name = 'webhook';
  control.Spec.TaskTemplate.ContainerSpec.Secrets = [{SecretID:'manager-key'}];
  const secrets = [
    {ID:'keep',Spec:{Name:'existing'}},
    {ID:'manager-key',Spec:{Name:'manager-key',Labels:{'bfast.admin.service':'abc123'}}},
    {ID:'other-key',Spec:{Name:'other-key',Labels:{'bfast.admin.service':'other-service'}}}
  ];
  const admin = createAdmin({password,jwtSecret:'x'.repeat(40),origin,now:() => clock,docker:async (method,path,body) => {
    calls.push({method,path,body});
    if (path === '/services') return [service,control];
    if (path === '/secrets') return secrets;
    if (path === '/secrets/create') {
      if (secrets.some(s => s.Spec.Name === body.Name)) throw Object.assign(new Error('Name already exists'),{status:409});
      const id = 'new-key-' + secrets.length;
      secrets.push({ID:id,Spec:{Name:body.Name,Labels:body.Labels}}); return {ID:id};
    }
    if (path.includes('/update')) return {};
    if (path === '/services/control') return {...service,Spec:{...service.Spec,Name:'webhook'}};
    return service;
  }});
  const app = express(); app.use(express.json({limit:'128kb'}));
  app.get('/admin',admin.page); app.get('/admin/app.js',admin.script); app.get('/admin/style.css',admin.style);
  app.post('/login',admin.login); app.get('/session',admin.session); app.post('/logout',admin.logout);
  app.get('/services/:service/secrets',admin.secrets); app.post('/services/:service/secrets',admin.createSecret);
  app.get('/services',admin.list); app.get('/services/:service',admin.detail); app.post('/services/:service',admin.update);
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
  let cookie='',csrf='';
  const send = async (path,body,headers={}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:body === undefined ? 'GET':'POST',headers:{origin,'content-type':'application/json',cookie,'x-csrf-token':csrf,...headers},body:body === undefined ? undefined:JSON.stringify(body)});
    const data = await res.text(); return {status:res.status,headers:res.headers,data: (() => {try{return JSON.parse(data);}catch{return data;}})()};
  };
  return {send,calls,advance:ms => clock+=ms,login:async () => {const r=await send('/login',{password});cookie=r.headers.get('set-cookie').split(';')[0];csrf=r.data.csrf;return r;}};
}
test('password login issues protected JWT cookie; auth required; logout revokes session',async t => {
  const s=await setup(t);
  assert.equal((await s.send('/services')).status,401); assert.equal(s.calls.length,0);
  assert.equal((await s.send('/login',{password:'wrong'})).status,401);
  const login=await s.login();assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await s.send('/session')).status,200);
  assert.equal((await s.send('/logout',{})).status,200);
  assert.equal((await s.send('/services')).status,401);
});
test('rejects wrong origins, absent CSRF, tampered tokens, and expired sessions',async t => {
  const s=await setup(t);
  assert.equal((await s.send('/login',{password},{origin:'https://evil.example.com'})).status,403);
  await s.login();
  assert.equal((await s.send('/logout',{}, {'x-csrf-token':''})).status,403);
  assert.equal((await s.send('/services',undefined,{cookie:'__Host-bfast-admin=invalid'})).status,401);
  s.advance(1801000); assert.equal((await s.send('/session')).status,401);
});
test('login attempts are rate limited without trusting proxy headers',async t => {
  const s=await setup(t);
  for(let i=0;i<10;i++) assert.equal((await s.send('/login',{password:'bad'},{'x-forwarded-for':String(i)})).status,401);
  assert.equal((await s.send('/login',{password})).status,429);
  s.advance(61000); assert.equal((await s.login()).status,200);
});
test('list omits secrets and protected services; direct protected access cannot update',async t => {
  const s=await setup(t);await s.login();
  const list=await s.send('/services');assert.deepEqual(list.data,[{id:'abc123',name:'example_faas',replicas:1}]);
  assert.equal((await s.send('/services/control')).status,403);
  assert.equal((await s.send('/services/control',{})).status,403);
  assert.equal(s.calls.some(c=>c.method==='POST'),false);
  assert.deepEqual((await s.send('/services/abc123')).data.env,service.Spec.TaskTemplate.ContainerSpec.Env);
});
test('updates env and settings while preserving unrelated spec and enforcing version',async t => {
  const s=await setup(t);await s.login();
  const {id,name,image,...input}=serviceDetail(service); input.env=['A=new=value','MULTI=line1\nline2'];input.replicas=2;
  assert.equal((await s.send('/services/abc123',{...input,version:6})).status,409);
  assert.equal((await s.send('/services/abc123',{...input,Mounts:[]})).status,400);
  assert.equal((await s.send('/services/abc123',input)).status,200);
  const update=s.calls.find(c=>c.method==='POST');assert.equal(update.path,'/services/abc123/update?version=7');
  assert.deepEqual(update.body.TaskTemplate.ContainerSpec.Env,input.env);
  assert.deepEqual(update.body.TaskTemplate.ContainerSpec.Secrets,service.Spec.TaskTemplate.ContainerSpec.Secrets);
  assert.deepEqual(update.body.TaskTemplate.Networks,service.Spec.TaskTemplate.Networks);
  assert.equal(update.body.TaskTemplate.ForceUpdate,1);assert.equal(update.body.Mode.Replicated.Replicas,2);
});
test('validation rejects duplicate, malformed, null-byte env and invalid settings',() => {
  const {id,name,image,...input}=serviceDetail(service);
  for(const patch of [{env:['A=x','A=y']},{env:['bad-key=value']},{env:['A=\0']},{replicas:-1},{replicas:1.5},{cpus:Infinity},{restart:'bad'},{memoryMB:-1}]) assert.throws(()=>updatedSpec(service,{...input,...patch}));
});
test('protects control labels, admin env, bind mounts, manager constraints and global services',() => {
  assert.equal(isEditable(service),true); assert.equal(isEditable(service,['example_faas']),false);
  for(const mutate of [s=>s.Spec.Labels['bfast.control']='true',s=>s.Spec.Labels['bfast.app']='bfast',s=>s.Spec.TaskTemplate.ContainerSpec.Env.push('PROJECT_ID=_BFAST_ADMIN'),s=>s.Spec.TaskTemplate.ContainerSpec.Mounts=[{Type:'bind',Source:'/var/run/docker.sock'}],s=>s.Spec.TaskTemplate.Placement={Constraints:['node.role == manager']},s=>s.Spec.Mode={Global:{}}]) {const s=structuredClone(service);mutate(s);assert.equal(isEditable(s),false);}
});
test('page and static assets have restrictive CSP and no-store',async t => {
  const s=await setup(t);
  for(const path of ['/admin','/admin/app.js','/admin/style.css']) {const r=await s.send(path);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);}
});

test('secret creation is authenticated, CSRF protected, scoped and write-only',async t => {
  const s=await setup(t);
  assert.equal((await s.send('/services/abc123/secrets')).status,401);
  assert.equal((await s.send('/services/abc123/secrets',{name:'db',value:'private'})).status,401);
  await s.login();
  assert.equal((await s.send('/services/control/secrets',{name:'db',value:'private'})).status,403);
  assert.equal((await s.send('/services/abc123/secrets',{name:'db',value:'private'},{'x-csrf-token':''})).status,403);
  const value='private unicode é\nwith newlines';
  const result=await s.send('/services/abc123/secrets',{name:'db-v1',value});
  assert.equal(result.status,201);assert.deepEqual(Object.keys(result.data).sort(),['id','name']);
  const created=s.calls.find(c=>c.path==='/secrets/create');
  assert.equal(created.body.Name,'app-abc123-db-v1');
  assert.equal(Buffer.from(created.body.Data,'base64').toString(),value);
  assert.equal(created.body.Labels['bfast.admin.service'],'abc123');
  const choices=await s.send('/services/abc123/secrets');
  assert.deepEqual(choices.data.map(s=>s.name),['existing','app-abc123-db-v1']);
  assert.equal(JSON.stringify(choices.data).includes('private'),false);
  assert.equal((await s.send('/services/abc123/secrets',{name:'db-v1',value:'second'})).status,409);
});
test('secret attachments preserve settings, reject foreign/control credentials and support detach',async t => {
  const s=await setup(t);await s.login();
  const secret=(await s.send('/services/abc123/secrets',{name:'db',value:'private'})).data;
  const {id,name,image,...input}=serviceDetail(service);
  const attachment={id:secret.id,target:'db-password',uid:'1000',gid:'1000',mode:256};
  for (const forbidden of ['manager-key','other-key','unknown']) {
    assert.equal((await s.send('/services/abc123',{...input,secrets:[{...attachment,id:forbidden}]})).status,403);
  }
  assert.equal(s.calls.some(c=>c.path.includes('/update')),false);
  assert.equal((await s.send('/services/abc123',{...input,secrets:[attachment]})).status,200);
  const update=s.calls.find(c=>c.path.includes('/update'));
  assert.deepEqual(update.body.TaskTemplate.ContainerSpec.Secrets,[{SecretID:secret.id,SecretName:secret.name,File:{Name:'db-password',UID:'1000',GID:'1000',Mode:256}}]);
  assert.deepEqual(update.body.TaskTemplate.Networks,service.Spec.TaskTemplate.Networks);
  assert.equal((await s.send('/services/abc123',{...input,secrets:[]})).status,200);
  assert.deepEqual(s.calls.filter(c=>c.path.includes('/update')).at(-1).body.TaskTemplate.ContainerSpec.Secrets,[]);
});
test('secret inputs reject paths, executable/writeable modes, duplicate mounts and oversized values',() => {
  for (const input of [{name:'../bad',value:'x'},{name:'ok',value:''},{name:'ok',value:'é'.repeat(32769)},{name:'ok',value:'x',Labels:{}}]) assert.throws(()=>newSecret(service,input));
  const choices=[{id:'keep',name:'existing'},{id:'second',name:'second'}];
  const ref={id:'keep',target:'password',uid:'0',gid:'0',mode:256};
  for (const patch of [{target:'../file'},{target:'/root/file'},{mode:511},{uid:'root'},{gid:'4294967295'},{File:{} }]) assert.throws(()=>secretAttachments(service,[{...ref,...patch}],choices));
  assert.throws(()=>secretAttachments(service,[ref,ref],choices));
  assert.throws(()=>secretAttachments(service,[ref,{...ref,id:'second'}],choices));
});
