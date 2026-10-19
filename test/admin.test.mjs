import assert from 'node:assert/strict';
import {test} from 'node:test';
import express from 'express';
import {request} from 'node:http';
import {createAdmin} from '../admin.mjs';
import {classify, updatedSpec, serviceDetail, actionSpec, newServiceSpec} from '../services.mjs';
import {parseAccess, serializeUsers} from '../auth.mjs';
import {demuxLogs} from '../docker.mjs';
import {createDeliveryLog, serviceWebhookSecret} from '../webhook.mjs';
import {newSecret, secretAttachments} from '../secrets.mjs';

const origin = 'https://admin.example.com', admin = 'admin@example.com', dev = 'dev@example.com';
const service = {ID:'abc123',CreatedAt:'2026-01-01T00:00:00Z',UpdatedAt:'2026-01-02T00:00:00Z',Version:{Index:7},Spec:{Name:'example_faas',Labels:{keep:'yes','traefik.http.routers.example-faas.rule':'Host(`example-faas.bfast.example.com`)'},Mode:{Replicated:{Replicas:1}},TaskTemplate:{ContainerSpec:{Image:'example:latest',Env:['A=old','MULTI=line1\nline2','PROJECT_ID=example'],Secrets:[{SecretID:'keep',SecretName:'existing',File:{Name:'existing',UID:'0',GID:'0',Mode:256}}]},Networks:[{Target:'network'}],RestartPolicy:{Condition:'any',Delay:5000000000},Resources:{Reservations:{MemoryBytes:1000}}}}};
const other = structuredClone(service); other.ID = 'other1'; other.Spec.Name = 'other_faas'; other.Spec.TaskTemplate.ContainerSpec.Env = ['B=1'];
const webhook = structuredClone(service); webhook.ID = 'control'; webhook.Spec.Name = 'webhook'; webhook.Version = {Index:3};
webhook.Spec.TaskTemplate.ContainerSpec.Env = ['WEBHOOK_SECRET_FILE=/run/secrets/x','ADMIN_JWT_SECRET_FILE=/run/secrets/j','ADMIN_ORIGIN='+origin,`ADMIN_EMAILS=${admin}`,`SERVICE_USERS=${dev}:example_faas`];
webhook.Spec.TaskTemplate.ContainerSpec.Secrets = [{SecretID:'manager-key'}];
const traefik = structuredClone(service); traefik.ID = 'tr'; traefik.Spec.Name = 'bfast_traefik'; traefik.Spec.Mode = {Global:{}}; traefik.Spec.TaskTemplate.ContainerSpec.Secrets = [];

async function setup(t, {accounts = {good: {email: admin, name: 'Admin'}, devtoken: {email: dev, name: 'Dev'}, nobody: {email: 'nobody@example.com', name: 'Nobody'}}} = {}) {
  const calls = []; let clock = Date.now();
  const services = [structuredClone(service), structuredClone(other), structuredClone(webhook), structuredClone(traefik)];
  const secrets = [{ID:'keep',Spec:{Name:'existing'}},{ID:'manager-key',Spec:{Name:'manager-key',Labels:{'bfast.admin.service':'abc123'}}},{ID:'other-key',Spec:{Name:'other-key',Labels:{'bfast.admin.service':'other-service'}}}];
  const tasks = [{ID:'t1',ServiceID:'abc123',Slot:1,NodeID:'n1',DesiredState:'running',Status:{State:'running',Timestamp:'2026-01-02T00:00:00Z',Message:'started'}},{ID:'t0',ServiceID:'abc123',Slot:1,NodeID:'n1',DesiredState:'shutdown',Status:{State:'failed',Timestamp:'2026-01-01T00:00:00Z',Err:'boom',ContainerStatus:{ExitCode:1}}}];
  const docker = async (method, path, body, options) => {
    calls.push({method, path, body});
    const url = new URL('http://x' + path), filter = url.searchParams.get('filters') ? JSON.parse(url.searchParams.get('filters')) : null;
    if (path.startsWith('/services?') || path === '/services') return filter?.name ? services.filter(s => filter.name.includes(s.Spec.Name)) : services;
    if (path === '/services/create') { if (services.some(s => s.Spec.Name === body.Name)) throw Object.assign(new Error('conflict'),{status:409}); const created = {ID:'new-'+body.Name,Version:{Index:1},Spec:body}; services.push(created); return {ID:created.ID}; }
    let m = path.match(/^\/services\/([^/?]+)\/update\?version=(\d+)$/);
    if (m) { const s = services.find(s => s.ID === m[1]); if (!s || s.Version.Index !== Number(m[2])) throw Object.assign(new Error('version'),{status:409}); s.Spec = body; s.Version = {Index: s.Version.Index + 1}; return {Warnings:[]}; }
    m = path.match(/^\/services\/([^/?]+)\/logs/);
    if (m) { const frame = text => { const b = Buffer.from(text); const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); }; return Buffer.concat([frame('2026-01-01T00:00:00Z line one\n'), frame('2026-01-01T00:00:01Z line two\n')]); }
    m = path.match(/^\/services\/([^/?]+)$/);
    if (m) { const s = services.find(s => s.ID === decodeURIComponent(m[1])); if (method === 'DELETE') { if (!s) throw Object.assign(new Error('nf'),{status:404}); services.splice(services.indexOf(s),1); return {}; } if (!s) throw Object.assign(new Error('nf'),{status:404}); return s; }
    if (path.startsWith('/tasks')) return tasks.filter(t => !filter?.service || filter.service.includes(t.ServiceID));
    if (path === '/nodes') return [{ID:'n1',Description:{Hostname:'manager-1',Resources:{NanoCPUs:4e9,MemoryBytes:8*1073741824},Engine:{EngineVersion:'27.0'},Platform:{OS:'linux',Architecture:'x86_64'}},Spec:{Role:'manager',Availability:'active'},Status:{State:'ready',Addr:'10.0.0.1'},ManagerStatus:{Leader:true,Reachability:'reachable'}}];
    if (path === '/info') return {Swarm:{LocalNodeState:'active',Nodes:1,Managers:1,Cluster:{ID:'c1'}},ServerVersion:'27.0',NCPU:4,MemTotal:8*1073741824};
    if (path === '/secrets') return secrets;
    if (path === '/secrets/create') { if (secrets.some(s => s.Spec.Name === body.Name)) throw Object.assign(new Error('exists'),{status:409}); const id = 'new-key-'+secrets.length; secrets.push({ID:id,Spec:{Name:body.Name,Labels:body.Labels}}); return {ID:id}; }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  const deliveryLog = createDeliveryLog();
  const make = () => createAdmin({jwtSecret:'x'.repeat(40), origin, now:() => clock, docker, adminEmails: admin, cluster:'bfast', hostDomain:'example.com', webhookSecret:'master-secret', deliveryLog,
    verifyIdToken: async token => { const a = accounts[token]; if (!a) throw Object.assign(new Error('bad token'),{status:401}); return {...a, picture:null}; }});
  let current = make(); const api = new Proxy({}, {get: (_, k) => (req, res) => current[k](req, res)});
  const app = express(); app.use(express.json({limit:'1mb'}));
  app.get('/admin',api.page); app.get('/admin/app.js',api.script); app.get('/admin/style.css',api.style); app.get('/config',api.config);
  app.post('/login',api.login); app.get('/session',api.session); app.post('/logout',api.logout); app.post('/sessions/end',api.endSessions);
  app.get('/swarm',api.swarm); app.get('/users',api.users); app.post('/users',api.saveUsers);
  app.get('/services',api.list); app.post('/services',api.create); app.get('/services/:service',api.detail); app.post('/services/:service',api.update);
  app.post('/services/:service/actions',api.action); app.get('/services/:service/tasks',api.tasks); app.get('/services/:service/logs',api.logs);
  app.get('/services/:service/webhook',api.webhook); app.post('/services/:service/webhook',api.webhookAction);
  app.get('/services/:service/secrets',api.secrets); app.post('/services/:service/secrets',api.createSecret);
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
  let cookie='',csrf='';
  const send = async (path,body,headers={},method) => {
    method ||= body === undefined ? 'GET' : 'POST';
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{origin,'content-type':'application/json',cookie,'x-csrf-token':csrf,...headers},body:body === undefined ? undefined:JSON.stringify(body)});
    const data = await res.text(); return {status:res.status,headers:res.headers,data:(() => {try{return JSON.parse(data);}catch{return data;}})()};
  };
  const login = async (token='good') => {const r=await send('/login',{idToken:token}); if (r.status===200){cookie=r.headers.get('set-cookie').split(';')[0];csrf=r.data.csrf;} return r;};
  const raw = (path, host) => new Promise((resolve, reject) => { const req = request({host:'127.0.0.1', port:server.address().port, path, headers:{host}}, res => { res.resume(); res.on('end', () => resolve({status:res.statusCode, headers:res.headers})); }); req.on('error', reject); req.end(); });
  return {send,raw,calls,services,deliveryLog,login,restart:()=>{current=make();},advance:ms => clock+=ms, reset:() => {cookie='';csrf='';}};
}
const input = s => { const {id,name,image,labels,constraints,networks,...rest} = serviceDetail(s); return rest; };

test('Google sign-in issues a session cookie; unknown accounts and unverifiable tokens are rejected',async t => {
  const s=await setup(t);
  assert.equal((await s.send('/services')).status,401);
  assert.equal((await s.send('/login',{idToken:'garbage'})).status,401);
  const nobody=await s.send('/login',{idToken:'nobody'}); assert.equal(nobody.status,403); assert.match(nobody.data.error,/no services assigned/);
  const login=await s.login(); assert.equal(login.status,200); assert.equal(login.data.user.role,'admin');
  assert.match(login.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);
  const session=await s.send('/session'); assert.equal(session.status,200); assert.equal(session.data.user.email,admin);
  assert.equal((await s.send('/logout',{})).status,200);
  assert.equal((await s.send('/services')).status,401);
});
test('rejects wrong origins, missing CSRF, tampered cookies and expired sessions',async t => {
  const s=await setup(t);
  assert.equal((await s.send('/login',{idToken:'good'},{origin:'https://evil.example.com'})).status,403);
  await s.login();
  assert.equal((await s.send('/logout',{},{'x-csrf-token':''})).status,403);
  assert.equal((await s.send('/services',undefined,{cookie:'__Host-bfast-admin=invalid'})).status,401);
  s.advance(9*3600*1000); assert.equal((await s.send('/session')).status,401);
});
test('admins see application services plus the management service; users only their assignments',async t => {
  const s=await setup(t); await s.login();
  const list=await s.send('/services'); assert.deepEqual(list.data.map(x => [x.name,x.kind,x.status,x.running]),[['example_faas','app','running',1],['other_faas','app','starting',0],['webhook','control','starting',0]]);
  assert.deepEqual(list.data[0].hosts,['example-faas.bfast.example.com']);
  s.reset(); await s.login('devtoken');
  const mine=await s.send('/services'); assert.deepEqual(mine.data.map(x => x.name),['example_faas']);
  assert.equal((await s.send('/services/other1')).status,403);
  assert.equal((await s.send('/services/control')).status,403);
  assert.equal((await s.send('/services/tr')).status,403);
  assert.equal((await s.send('/swarm')).status,403);
  assert.equal((await s.send('/users')).status,403);
  assert.equal((await s.send('/services',{project:'x'})).status,403);
  const detail=await s.send('/services/abc123'); assert.equal(detail.status,200); assert.equal(detail.data.canEditSettings,false); assert.deepEqual(detail.data.imageOptions,[]); assert.equal(detail.data.users,undefined);
  assert.equal(detail.data.tasks[0].node,'manager-1'); assert.equal(detail.data.tasks[1].error,'boom');
});
test('updates env and settings while preserving unrelated spec and enforcing version; images come from ALLOWED_IMAGES',async t => {
  const s=await setup(t);
  s.services[2].Spec.TaskTemplate.ContainerSpec.Env.push('ALLOWED_IMAGES=joshuamshana/bfastfunction:latest, joshuamshana/bfastfunction:3.2.4 -bad, :x');
  await s.login();
  const detail=(await s.send('/services/abc123')).data; assert.equal(detail.canEditSettings,true);
  assert.deepEqual(detail.imageOptions,['example:latest','joshuamshana/bfastfunction:latest','joshuamshana/bfastfunction:3.2.4']);
  assert.equal((await s.send('/services/abc123',{...input(service),image:'joshuamshana/other:1'})).status,400);
  const body={...input(service),env:['A=new=value','MULTI=line1\nline2','PROJECT_ID=example'],replicas:2};
  assert.equal((await s.send('/services/abc123',{...body,version:6})).status,409);
  assert.equal((await s.send('/services/abc123',{...body,Mounts:[]})).status,400);
  assert.equal((await s.send('/services/abc123',{...body,image:'bad image'})).status,400);
  assert.equal((await s.send('/services/abc123',{...body,image:'joshuamshana/bfastfunction:3.2.4'})).status,200);
  const update=s.calls.find(c=>c.path.includes('/update')); assert.equal(update.path,'/services/abc123/update?version=7');
  assert.deepEqual(update.body.TaskTemplate.ContainerSpec.Env,body.env); assert.equal(update.body.TaskTemplate.ContainerSpec.Image,'joshuamshana/bfastfunction:3.2.4');
  assert.deepEqual(update.body.TaskTemplate.ContainerSpec.Secrets,service.Spec.TaskTemplate.ContainerSpec.Secrets);
  assert.deepEqual(update.body.TaskTemplate.Networks,service.Spec.TaskTemplate.Networks); assert.equal(update.body.Mode.Replicated.Replicas,2);
  s.reset(); await s.login('devtoken');
  assert.equal((await s.send('/services/abc123',{...body,version:8,image:'x:1'})).status,400);
  // Users may edit env but must resend the current resource settings unchanged.
  for (const patch of [{replicas:3},{cpus:1},{memoryMB:512},{restart:'none'}]) assert.equal((await s.send('/services/abc123',{...body,version:8,...patch})).status,403);
  assert.equal((await s.send('/services/abc123',{...body,version:8,env:['A=user']})).status,200);
  assert.equal(s.services[0].Spec.Mode.Replicated.Replicas,2);
});
test('image changes are disabled without ALLOWED_IMAGES; new services use the default image',async t => {
  const s=await setup(t); await s.login();
  const r=await s.send('/services/abc123',{...input(service),image:'joshuamshana/bfastfunction:3.2.4'}); assert.equal(r.status,400); assert.match(r.data.error,/ALLOWED_IMAGES/);
  assert.equal((await s.send('/services/abc123',{...input(service),image:'example:latest'})).status,200);
  assert.equal((await s.send('/services',{project:'demo',image:'evil/miner:1',replicas:0,cpus:0,memoryMB:0,restart:'any'})).status,400);
  assert.equal((await s.send('/services',{project:'demo',replicas:0,cpus:0,memoryMB:0,restart:'any'})).status,201);
  assert.deepEqual((await s.send('/session')).data.defaults.images,['joshuamshana/bfastfunction:latest']);
});
test('management service edits keep it alive and keep the current admin',async t => {
  const s=await setup(t); await s.login();
  const detail=(await s.send('/services/control')).data; const body=input(webhook); body.version=detail.version;
  assert.equal((await s.send('/services/control',{...body,replicas:0})).status,400);
  assert.equal((await s.send('/services/control',{...body,env:body.env.filter(e=>!e.startsWith('ADMIN_EMAILS'))})).status,400);
  assert.equal((await s.send('/services/control',{...body,env:body.env.filter(e=>!e.startsWith('ADMIN_ORIGIN'))})).status,400);
  assert.equal((await s.send('/services/control',{...body,secrets:[]})).status,400);
  const ok=await s.send('/services/control',{...body,env:[...body.env,'EXTRA=1']}); assert.equal(ok.status,200); assert.match(ok.data.message,/restarts/);
  assert.equal((await s.send('/services/control/actions',{action:'archive'})).status,400);
  assert.equal((await s.send('/services/control/actions',{action:'restart'})).status,200);
  assert.equal((await s.send('/services/control/secrets')).status,403);
});
test('archive scales to 0, unarchive scales to 1, restart needs a running service',async t => {
  const s=await setup(t); await s.login();
  s.services[0].Spec.Mode.Replicated.Replicas=3;
  assert.equal((await s.send('/services/abc123/actions',{action:'archive'})).status,200);
  assert.equal(s.services[0].Spec.Mode.Replicated.Replicas,0); assert.equal(s.services[0].Spec.Labels.keep,'yes');
  assert.equal((await s.send('/services')).data[0].status,'archived');
  assert.equal((await s.send('/services/abc123/actions',{action:'archive'})).status,400);
  assert.equal((await s.send('/services/abc123/actions',{action:'restart'})).status,400);
  assert.equal((await s.send('/services/abc123/actions',{action:'unarchive'})).status,200);
  assert.equal(s.services[0].Spec.Mode.Replicated.Replicas,1);
  assert.equal((await s.send('/services/abc123/actions',{action:'unarchive'})).status,400);
  assert.deepEqual(s.services[0].Spec.TaskTemplate.Networks,service.Spec.TaskTemplate.Networks);
  for (const action of ['start','stop','delete','explode']) assert.equal((await s.send('/services/abc123/actions',{action})).status,400);
});
test('logs are demultiplexed and tailed; tasks listed newest first',async t => {
  const s=await setup(t); await s.login();
  const logs=await s.send('/services/abc123/logs?tail=1'); assert.equal(logs.status,200); assert.equal(logs.data.tail,10); assert.deepEqual(logs.data.lines,['2026-01-01T00:00:00Z line one','2026-01-01T00:00:01Z line two']);
  assert.match(s.calls.find(c=>c.path.includes('/logs')).path,/tail=10\b/);
  const tasks=await s.send('/services/abc123/tasks'); assert.deepEqual(tasks.data.map(t=>t.state),['running','failed']);
  assert.equal(demuxLogs(Buffer.from('plain text')),'plain text');
});
test('admins create services with Traefik labels, defaults and optional user assignment',async t => {
  const s=await setup(t); await s.login();
  assert.equal((await s.send('/services',{project:'Bad_Name',replicas:1,cpus:0,memoryMB:0,restart:'any'})).status,400);
  assert.equal((await s.send('/services',{project:'example',replicas:1,cpus:0,memoryMB:0,restart:'any'})).status,409);
  const r=await s.send('/services',{project:'demo',env:['MODE=git','GIT_CLONE_URL=https://github.com/acme/demo.git','PORT=9'],replicas:0,cpus:0.5,memoryMB:256,restart:'any',hosts:['Api.Example.org'],users:[dev,'new@example.com']});
  assert.equal(r.status,201); assert.equal(r.data.name,'demo_faas'); assert.deepEqual(r.data.hosts,['demo-faas.bfast.example.com','demo.api.example.com','api.example.org']);
  const spec=s.calls.find(c=>c.path==='/services/create').body;
  assert.equal(spec.Labels['traefik.http.routers.demo-faas.rule'],'Host(`demo-faas.bfast.example.com`) || Host(`demo.api.example.com`) || Host(`api.example.org`)');
  assert.equal(spec.Labels['traefik.http.services.demo-faas.loadbalancer.server.port'],'3000'); assert.equal(spec.Labels['bfast.project'],'demo');
  assert.deepEqual(spec.TaskTemplate.ContainerSpec.Env,['PROJECT_ID=demo','PORT=3000','PRODUCTION=1','MODE=git','GIT_CLONE_URL=https://github.com/acme/demo.git']);
  assert.equal(spec.TaskTemplate.Resources.Limits.NanoCPUs,5e8); assert.equal(spec.Mode.Replicated.Replicas,0); assert.deepEqual(spec.TaskTemplate.Networks,[{Target:'bfastweb'}]);
  // Same options as create_faas.sh: hostname, restart delay, TLS resolver, sticky cookie, network label.
  assert.equal(spec.TaskTemplate.ContainerSpec.Hostname,'demo_faas'); assert.deepEqual(spec.TaskTemplate.RestartPolicy,{Condition:'any',Delay:5e9});
  assert.equal(spec.Labels['traefik.http.routers.demo-faas.tls.certresolver'],'le'); assert.equal(spec.Labels['traefik.http.routers.demo-faas.tls'],'true');
  assert.equal(spec.Labels['traefik.http.services.demo-faas.loadbalancer.sticky.cookie'],'true'); assert.equal(spec.Labels['traefik.docker.network'],'bfastweb'); assert.equal(spec.Labels['traefik.enable'],'true');
  const self=s.services.find(x=>x.Spec.Name==='webhook'); assert.ok(self.Spec.TaskTemplate.ContainerSpec.Env.includes(`SERVICE_USERS=${dev}:example_faas,demo_faas;new@example.com:demo_faas`));
  s.reset(); await s.login('devtoken'); assert.deepEqual((await s.send('/services')).data.map(x=>x.name),['demo_faas','example_faas']);
});
test('user management rewrites SERVICE_USERS on the management service',async t => {
  const s=await setup(t); await s.login();
  const users=await s.send('/users'); assert.deepEqual(users.data.users,[{email:dev,services:['example_faas']}]); assert.deepEqual(users.data.services,['example_faas','other_faas']); assert.equal(users.data.manageable,true);
  assert.equal((await s.send('/users',{users:[{email:admin,services:['example_faas']}]})).status,400);
  assert.equal((await s.send('/users',{users:[{email:'bad',services:[]}]})).status,400);
  assert.equal((await s.send('/users',{users:[],version:1})).status,409);
  const r=await s.send('/users',{users:[{email:'New@Example.com ',services:['other_faas']},{email:dev,services:['example_faas','other_faas']}],version:users.data.version});
  assert.equal(r.status,200);
  const self=s.services.find(x=>x.Spec.Name==='webhook'); assert.ok(self.Spec.TaskTemplate.ContainerSpec.Env.includes(`SERVICE_USERS=new@example.com:other_faas;${dev}:example_faas,other_faas`));
  assert.ok(self.Spec.TaskTemplate.ContainerSpec.Env.includes('ADMIN_EMAILS='+admin));
  s.reset(); await s.login('devtoken'); assert.deepEqual((await s.send('/services')).data.map(x=>x.name),['example_faas','other_faas']);
  await s.send('/logout',{}); s.reset(); await s.login();
  assert.equal((await s.send('/users',{users:[]})).status,200);
  assert.equal(self.Spec.TaskTemplate.ContainerSpec.Env.some(e=>e.startsWith('SERVICE_USERS=')),false);
  s.reset(); assert.equal((await s.login('devtoken')).status,403);
});
test('services cannot be deleted through the console',async t => {
  const s=await setup(t); await s.login();
  assert.equal((await s.send('/services/abc123',{name:'example_faas'},{},'DELETE')).status,404);
  assert.equal(s.calls.some(c=>c.method==='DELETE'),false);
  assert.equal(s.services.some(x=>x.ID==='abc123'),true);
});
test('swarm overview is admin-only and lists nodes and every service',async t => {
  const s=await setup(t); await s.login();
  const r=await s.send('/swarm'); assert.equal(r.status,200); assert.equal(r.data.swarm.state,'active'); assert.equal(r.data.nodes[0].hostname,'manager-1'); assert.equal(r.data.nodes[0].leader,true);
  assert.deepEqual(r.data.services.map(x=>[x.name,x.kind]),[['bfast_traefik','protected'],['example_faas','app'],['other_faas','app'],['webhook','control']]);
});
test('page, assets and config have restrictive CSP and no-store',async t => {
  const s=await setup(t);
  const moved=await s.raw('/admin','old-host.example.com'); assert.equal(moved.status,301); assert.equal(moved.headers.location,origin+'/admin');
  const page=await s.raw('/admin','admin.example.com'); assert.equal(page.status,200); assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
  for(const path of ['/admin/app.js','/admin/style.css','/config']) {const r=await s.send(path);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(r.headers.get('content-security-policy'),/www\.gstatic\.com/);}
  assert.equal((await s.send('/config')).data.firebase.projectId,'bfastapp');
});
test('access policy parsing tolerates whitespace, case and duplicates',() => {
  const access=parseAccess(' Admin@Example.com, bad, b@x.io ', 'Dev@Example.com:a_faas, b_faas;dev@example.com:c_faas;junk;x@y.z:');
  assert.deepEqual([...access.admins],['admin@example.com','b@x.io']);
  assert.deepEqual([...access.users.get('dev@example.com')],['a_faas','b_faas','c_faas']); assert.equal(access.users.has('x@y.z'),true);
  assert.equal(serializeUsers(access.users),'dev@example.com:a_faas,b_faas,c_faas');
});
test('validation rejects duplicate, malformed, null-byte env and invalid settings; spec builders',() => {
  for(const patch of [{env:['A=x','A=y']},{env:['bad-key=value']},{env:['A=\0']},{replicas:-1},{replicas:1.5},{cpus:Infinity},{restart:'bad'},{memoryMB:-1}]) assert.throws(()=>updatedSpec(service,{...input(service),...patch}));
  assert.throws(()=>actionSpec({Spec:{Mode:{Replicated:{Replicas:0}},TaskTemplate:{}}},'restart'));
  assert.throws(()=>newServiceSpec({project:'demo',replicas:1,cpus:0,memoryMB:0,restart:'any'},{defaultImage:'img'}),/hostname/);
  assert.throws(()=>newServiceSpec({project:'demo',replicas:1,cpus:0,memoryMB:0,restart:'any',hosts:['not a host']},{defaultImage:'img'}));
  assert.equal(newServiceSpec({project:'demo',replicas:1,cpus:0,memoryMB:0,restart:'any',hosts:['a.example.com'],sticky:false},{defaultImage:'img'}).Labels['traefik.http.services.demo-faas.loadbalancer.sticky.cookie'],undefined);
});
test('classification protects control labels, admin env, bind mounts, manager constraints and global services',() => {
  assert.equal(classify(service),'app'); assert.equal(classify(service,{excluded:['example_faas']}),'protected'); assert.equal(classify(webhook),'control'); assert.equal(classify(webhook,{selfName:'manager'}),'protected');
  for(const mutate of [s=>s.Spec.Labels['bfast.control']='true',s=>s.Spec.Labels['bfast.app']='bfast',s=>s.Spec.TaskTemplate.ContainerSpec.Env.push('PROJECT_ID=_BFAST_ADMIN'),s=>s.Spec.TaskTemplate.ContainerSpec.Mounts=[{Type:'bind',Source:'/var/run/docker.sock'}],s=>s.Spec.TaskTemplate.Placement={Constraints:['node.role == manager']},s=>s.Spec.Mode={Global:{}}]) {const s=structuredClone(service);mutate(s);assert.equal(classify(s),'protected');}
});
test('secret creation is authenticated, scoped and write-only; attachments reject foreign credentials',async t => {
  const s=await setup(t);
  assert.equal((await s.send('/services/abc123/secrets')).status,401);
  await s.login();
  assert.equal((await s.send('/services/abc123/secrets',{name:'db',value:'private'},{'x-csrf-token':''})).status,403);
  const value='private unicode é\nwith newlines';
  const result=await s.send('/services/abc123/secrets',{name:'db-v1',value}); assert.equal(result.status,201); assert.deepEqual(Object.keys(result.data).sort(),['id','name']);
  const created=s.calls.find(c=>c.path==='/secrets/create'); assert.equal(created.body.Name,'app-abc123-db-v1'); assert.equal(Buffer.from(created.body.Data,'base64').toString(),value);
  const choices=await s.send('/services/abc123/secrets'); assert.deepEqual(choices.data.map(x=>x.name),['existing','app-abc123-db-v1']); assert.equal(JSON.stringify(choices.data).includes('private'),false);
  assert.equal((await s.send('/services/abc123/secrets',{name:'db-v1',value:'second'})).status,409);
  const body=input(service), attachment={id:result.data.id,target:'db-password',uid:'1000',gid:'1000',mode:256};
  for (const forbidden of ['manager-key','other-key','unknown']) assert.equal((await s.send('/services/abc123',{...body,secrets:[{...attachment,id:forbidden}]})).status,403);
  assert.equal((await s.send('/services/abc123',{...body,secrets:[attachment]})).status,200);
  const update=s.calls.find(c=>c.path.includes('/update')); assert.deepEqual(update.body.TaskTemplate.ContainerSpec.Secrets,[{SecretID:result.data.id,SecretName:result.data.name,File:{Name:'db-password',UID:'1000',GID:'1000',Mode:256}}]);
});
test('secret inputs reject paths, executable modes, duplicate mounts and oversized values',() => {
  for (const i of [{name:'../bad',value:'x'},{name:'ok',value:''},{name:'ok',value:'é'.repeat(32769)},{name:'ok',value:'x',Labels:{}}]) assert.throws(()=>newSecret(service,i));
  const choices=[{id:'keep',name:'existing'},{id:'second',name:'second'}], ref={id:'keep',target:'password',uid:'0',gid:'0',mode:256};
  for (const patch of [{target:'../file'},{target:'/root/file'},{mode:511},{uid:'root'},{gid:'4294967295'},{File:{}}]) assert.throws(()=>secretAttachments(service,[{...ref,...patch}],choices));
  assert.throws(()=>secretAttachments(service,[ref,ref],choices)); assert.throws(()=>secretAttachments(service,[ref,{...ref,id:'second'}],choices));
});

test('auto-deploy details show the per-service secret and readiness; rotate and pause only change labels',async t => {
  const s=await setup(t); await s.login('devtoken');
  s.services[0].Spec.TaskTemplate.ContainerSpec.Env.push('MODE=git','GIT_CLONE_URL=https://github.com/acme/demo.git');
  s.deliveryLog.record('example_faas',{result:'deployed',branch:'main'});
  let w=(await s.send('/services/abc123/webhook')).data;
  assert.equal(w.url,origin+'/github-webhook/example_faas'); assert.equal(w.ready,true); assert.equal(w.repository,'acme/demo');
  assert.equal(w.settingsUrl,'https://github.com/acme/demo/settings/hooks'); assert.equal(w.secret,serviceWebhookSecret('master-secret','example_faas',0));
  assert.equal(w.deliveries[0].result,'deployed'); assert.equal((await s.send('/services')).data[0].autoDeploy,'on');
  assert.equal((await s.send('/services/abc123/webhook',{action:'rotate',version:w.version-1})).status,409);
  assert.equal((await s.send('/services/abc123/webhook',{action:'explode',version:w.version})).status,400);
  const forceBefore=s.services[0].Spec.TaskTemplate.ForceUpdate;
  const rotated=(await s.send('/services/abc123/webhook',{action:'rotate',version:w.version})).data;
  assert.equal(rotated.generation,1); assert.equal(rotated.secret,serviceWebhookSecret('master-secret','example_faas',1)); assert.notEqual(rotated.secret,w.secret);
  assert.equal(s.services[0].Spec.TaskTemplate.ForceUpdate,forceBefore);
  const paused=(await s.send('/services/abc123/webhook',{action:'pause',version:rotated.version})).data; assert.equal(paused.paused,true);
  assert.equal((await s.send('/services')).data[0].autoDeploy,'paused');
  assert.equal((await s.send('/services/abc123/webhook',{action:'resume',version:paused.version})).data.paused,false);
  assert.equal((await s.send('/services/other1/webhook')).status,403);
});
test('auto-deploy explains why a service is not ready',async t => {
  const s=await setup(t); await s.login();
  s.services[1].Spec.TaskTemplate.ContainerSpec.Env=['MODE=npm','NPM_TAR=pkg'];
  const w=(await s.send('/services/other1/webhook')).data;
  assert.equal(w.ready,false); assert.match(w.problems[0],/MODE is "npm"/); assert.equal((await s.send('/services')).data[1].autoDeploy,'off');
});

const cookieOf = r => r.headers.get('set-cookie')?.split(';')[0];
test('sessions last one hour, renew while used, keep the CSRF token and stop at the absolute limit',async t => {
  const s=await setup(t);
  const login=await s.login(); assert.match(login.headers.get('set-cookie'),/Max-Age=3600/);
  const csrf=login.data.csrf; let cookie=cookieOf(login);
  s.advance(5*60*1000); const early=await s.send('/session',undefined,{cookie}); assert.equal(early.status,200); assert.equal(early.headers.get('set-cookie'),null);
  for (let i=0;i<20;i++) {
    s.advance(50*60*1000);
    const r=await s.send('/session',undefined,{cookie});
    if (r.status!==200) { assert.ok(i>=13, 'absolute limit reached too early at step '+i); assert.equal(r.status,401); return; }
    assert.equal(r.data.csrf,csrf); const next=cookieOf(r); assert.ok(next); cookie=next;
  }
  assert.fail('session outlived the 12-hour limit');
});
test('an idle session expires after one hour',async t => {
  const s=await setup(t); const login=await s.login(); const cookie=cookieOf(login);
  s.advance(61*60*1000); assert.equal((await s.send('/session',undefined,{cookie})).status,401);
});
test('signing out ends every session of that account, durably across restarts, via a label-only update',async t => {
  const s=await setup(t);
  const a=await s.login(); const b=await s.login();
  const ca=cookieOf(a), cb=cookieOf(b);
  s.advance(1000);
  const before=structuredClone(s.services[2].Spec);
  const out=await s.send('/logout',{},{cookie:ca,'x-csrf-token':a.data.csrf}); assert.equal(out.status,200); assert.equal(out.data.everywhere,true);
  assert.equal((await s.send('/session',undefined,{cookie:cb})).status,401);
  const after=s.services[2].Spec, keys=Object.keys(after.Labels).filter(k=>k.startsWith('bfast.session.after.'));
  assert.equal(keys.length,1); assert.doesNotMatch(keys[0],/@/);
  assert.equal(after.TaskTemplate.ForceUpdate,before.TaskTemplate.ForceUpdate); assert.deepEqual(after.TaskTemplate,before.TaskTemplate);
  s.restart(); assert.equal((await s.send('/session',undefined,{cookie:cb})).status,401);
  s.advance(1000); const again=await s.login(); assert.equal(again.status,200); assert.equal((await s.send('/session',undefined,{cookie:cookieOf(again)})).status,200);
  // Labels older than one session lifetime are pruned on the next sign-out.
  s.advance(2*3600*1000); const later=await s.login(); await s.send('/logout',{},{cookie:cookieOf(later),'x-csrf-token':later.data.csrf});
  assert.equal(Object.keys(s.services[2].Spec.Labels).filter(k=>k.startsWith('bfast.session.after.')).length,1);
});
test('admins can end another user\'s sessions; users cannot',async t => {
  const s=await setup(t);
  const dev=await s.login('devtoken'); const devCookie=cookieOf(dev);
  assert.equal((await s.send('/sessions/end',{email:'admin@example.com'},{cookie:devCookie,'x-csrf-token':dev.data.csrf})).status,403);
  s.reset(); const adm=await s.login(); s.advance(1000);
  assert.equal((await s.send('/sessions/end',{email:'not-an-email'})).status,400);
  const r=await s.send('/sessions/end',{email:'DEV@example.com '}); assert.equal(r.status,200); assert.equal(r.data.durable,true);
  assert.equal((await s.send('/session',undefined,{cookie:devCookie})).status,401);
  assert.equal((await s.send('/session',undefined,{cookie:cookieOf(adm)})).status,200);
  s.advance(1000); assert.equal((await s.login('devtoken')).status,200);
});
