import {request} from 'node:http';
import {readFileSync} from 'node:fs';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {SignJWT, jwtVerify} from 'jose';
import {secretReference, secretChoices, newSecret, secretAttachments} from './secrets.mjs';

const cookieName = '__Host-bfast-admin';
const ttl = 1800;
const fail = (status, message) => Object.assign(new Error(message), {status});
const digest = value => createHash('sha256').update(value).digest();

export function dockerRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({socketPath: '/var/run/docker.sock', path, method,
      headers: {'Content-Type': 'application/json'}}, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 8_000_000) req.destroy(new Error('Response too large')); });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(fail(res.statusCode === 409 ? 409 : 502,
          res.statusCode === 409 ? 'Docker resource changed or its name is already in use. Refresh and retry.' : 'Docker operation failed'));
        try { resolve(data ? JSON.parse(data) : {}); } catch { reject(fail(502, 'Invalid Docker response')); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Docker timeout')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

export function isEditable(service, excluded = []) {
  const spec = service.Spec || {}, task = spec.TaskTemplate || {}, container = task.ContainerSpec || {};
  const name = spec.Name || '';
  return Boolean(spec.Mode?.Replicated && !excluded.includes(name)
    && !/(^|_)(webhook|traefik|bfast|control)(_|$)/i.test(name)
    && spec.Labels?.['bfast.control'] !== 'true' && spec.Labels?.['bfast.app'] !== 'bfast'
    && !(container.Env || []).includes('PROJECT_ID=_BFAST_ADMIN')
    && !(container.Mounts || []).some(m => m.Type === 'bind')
    && !(task.Placement?.Constraints || []).some(c => /node\.role\s*==\s*manager/i.test(c)));
}

export function serviceDetail(service) {
  const t = service.Spec.TaskTemplate;
  return {id: service.ID, name: service.Spec.Name, version: service.Version.Index,
    image: t.ContainerSpec.Image, env: t.ContainerSpec.Env || [],
    replicas: service.Spec.Mode.Replicated.Replicas ?? 1,
    cpus: (t.Resources?.Limits?.NanoCPUs || 0) / 1e9,
    memoryMB: (t.Resources?.Limits?.MemoryBytes || 0) / 1048576,
    restart: t.RestartPolicy?.Condition || 'any'};
}

export function updatedSpec(service, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(k => !['version', 'env', 'replicas', 'cpus', 'memoryMB', 'restart', 'secrets'].includes(k))) throw fail(400, 'Unsupported settings');
  if (!Number.isSafeInteger(input.version) || input.version !== service.Version.Index) throw fail(409, 'Service changed. Reload before saving.');
  if (!Array.isArray(input.env) || input.env.length > 300) throw fail(400, 'Invalid environment variables');
  const keys = new Set();
  for (const entry of input.env) {
    if (typeof entry !== 'string' || entry.length > 32768 || entry.includes('\0') || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry)) throw fail(400, 'Use valid KEY=value environment variables');
    const key = entry.slice(0, entry.indexOf('='));
    if (keys.has(key)) throw fail(400, 'Duplicate environment variable');
    keys.add(key);
  }
  if (!Number.isInteger(input.replicas) || input.replicas < 0 || input.replicas > 100
    || !Number.isFinite(input.cpus) || input.cpus < 0 || input.cpus > 128
    || !Number.isFinite(input.memoryMB) || input.memoryMB < 0 || input.memoryMB > 1048576
    || !['any', 'on-failure', 'none'].includes(input.restart)) throw fail(400, 'Invalid deployment settings');
  const spec = structuredClone(service.Spec);
  spec.TaskTemplate.ContainerSpec.Env = input.env;
  spec.Mode.Replicated.Replicas = input.replicas;
  const t = spec.TaskTemplate;
  t.Resources ||= {}; t.Resources.Limits ||= {};
  t.Resources.Limits.NanoCPUs = Math.round(input.cpus * 1e9);
  t.Resources.Limits.MemoryBytes = Math.round(input.memoryMB * 1048576);
  t.RestartPolicy = {...t.RestartPolicy, Condition: input.restart};
  t.ForceUpdate = (t.ForceUpdate || 0) + 1;
  return spec;
}

export function createAdmin({password, jwtSecret, origin, docker = dockerRequest,
  excluded = [], now = () => Date.now()} = {}) {
  if (!password || password.length < 16 || !jwtSecret || jwtSecret.length < 32) throw new Error('Admin secrets require a 16+ character password and 32+ character signing key');
  if (!origin || new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('ADMIN_ORIGIN must be an exact HTTPS origin');
  const key = Buffer.from(jwtSecret), passwordHash = digest(password), sessions = new Map();
  let attempts = [], mutation = false;
  const headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
  const wrap = (action, {publicRoute = false, write = false} = {}) => async (req, res) => {
    for (const [k,v] of Object.entries(headers)) res.setHeader(k,v);
    try {
      if (write && (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))) throw fail(403, 'Same-origin JSON request required');
      for (const [id,s] of sessions) if (s.expires <= now()) sessions.delete(id);
      let session, claims;
      if (!publicRoute) {
        try {
          const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
          claims = (await jwtVerify(token, key, {algorithms: ['HS256'], issuer: origin, audience: 'bfast-admin', currentDate: new Date(now())})).payload;
          session = sessions.get(claims.jti);
          if (!session) throw new Error();
        } catch { throw fail(401, 'Please sign in'); }
        if (write && req.headers['x-csrf-token'] !== session.csrf) throw fail(403, 'Invalid request token');
      }
      await action(req, res, session, claims);
    } catch (error) { res.status(error.status || 502).json({error: error.status ? error.message : 'Service operation failed'}); }
  };
  const inspect = async id => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id || '')) throw fail(404, 'Service unavailable');
    const service = await docker('GET', `/services/${encodeURIComponent(id)}`);
    if (!isEditable(service, excluded)) throw fail(403, 'Control or infrastructure service is protected');
    return service;
  };
  return {
    page: wrap(async (_,res) => res.type('html').send(readFileSync(new URL('./admin/index.html', import.meta.url), 'utf8')), {publicRoute: true}),
    script: wrap(async (_,res) => res.type('js').send(readFileSync(new URL('./admin/app.js', import.meta.url), 'utf8')), {publicRoute: true}),
    style: wrap(async (_,res) => res.type('css').send(readFileSync(new URL('./admin/style.css', import.meta.url), 'utf8')), {publicRoute: true}),
    login: wrap(async (req,res) => {
      attempts = attempts.filter(t => now() - t < 60000);
      if (attempts.length >= 10) {res.setHeader('Retry-After','60'); throw fail(429, 'Too many login attempts. Try again in a minute.');}
      attempts.push(now());
      if (typeof req.body?.password !== 'string' || req.body.password.length > 1024 || !timingSafeEqual(passwordHash, digest(req.body.password))) throw fail(401, 'Invalid password');
      if (sessions.size >= 100) throw fail(429, 'Too many active sessions');
      const id = randomBytes(24).toString('hex'), csrf = randomBytes(32).toString('hex');
      const token = await new SignJWT({}).setProtectedHeader({alg: 'HS256', typ: 'JWT'}).setIssuer(origin).setAudience('bfast-admin').setSubject('shared-admin').setJti(id).setIssuedAt(Math.floor(now()/1000)).setExpirationTime(Math.floor(now()/1000)+ttl).sign(key);
      sessions.set(id, {csrf, expires: now()+ttl*1000});
      res.setHeader('Set-Cookie', cookie(token, ttl)); res.json({csrf});
    }, {publicRoute: true, write: true}),
    session: wrap(async (_,res,s) => res.json({csrf: s.csrf})),
    logout: wrap(async (_,res,s,c) => {sessions.delete(c.jti); res.setHeader('Set-Cookie',cookie('',0)); res.json({ok:true});}, {write:true}),
    list: wrap(async (_,res) => res.json((await docker('GET','/services')).filter(s => isEditable(s,excluded)).map(s => ({id:s.ID,name:s.Spec.Name,replicas:s.Spec.Mode.Replicated.Replicas ?? 1})))),
    detail: wrap(async (req,res) => {
      const service = await inspect(req.params.service);
      res.json({...serviceDetail(service), secrets:(service.Spec.TaskTemplate.ContainerSpec.Secrets || []).map(secretReference)});
    }),
    secrets: wrap(async (req,res) => {
      const service = await inspect(req.params.service);
      res.json(await secretChoices(docker, service, s => isEditable(s, excluded)));
    }),
    createSecret: wrap(async (req,res) => {
      if (mutation) throw fail(409, 'An update is in progress. Try again shortly.');
      mutation = true;
      try {
        const service = await inspect(req.params.service);
        const spec = newSecret(service, req.body);
        const result = await docker('POST', '/secrets/create', spec);
        res.status(201).json({id:result.ID, name:spec.Name});
      } finally {mutation = false;}
    }, {write:true}),
    update: wrap(async (req,res) => {
      if (mutation) throw fail(409, 'An update is in progress. Try again shortly.');
      mutation = true;
      try {
        if ((JSON.stringify(req.body) || '').length > 131072) throw fail(413,'Settings too large');
        const service = await inspect(req.params.service), spec = updatedSpec(service,req.body);
        if (req.body.secrets !== undefined) {
          const choices = await secretChoices(docker, service, s => isEditable(s, excluded));
          spec.TaskTemplate.ContainerSpec.Secrets = secretAttachments(service, req.body.secrets, choices);
        }
        const result = await docker('POST',`/services/${service.ID}/update?version=${service.Version.Index}`,spec);
        res.json({ok:true,message:'Update accepted. Swarm is rolling out the new configuration.',warnings:result.Warnings || []});
      } finally {mutation = false;}
    }, {write:true})
  };
}

export function configuredAdmin() {
  if (!process.env.ADMIN_PASSWORD_FILE || !process.env.ADMIN_JWT_SECRET_FILE || !process.env.ADMIN_ORIGIN) {
    const disabled = (_,res) => res.status(503).json({error:'Service manager is not configured'});
    return Object.fromEntries(['page','script','style','login','session','logout','list','detail','update','secrets','createSecret'].map(k => [k,disabled]));
  }
  return createAdmin({password:readFileSync(process.env.ADMIN_PASSWORD_FILE,'utf8').trim(),
    jwtSecret:readFileSync(process.env.ADMIN_JWT_SECRET_FILE,'utf8').trim(), origin:process.env.ADMIN_ORIGIN,
    excluded:(process.env.ADMIN_EXCLUDED_SERVICES || '').split(',').map(s => s.trim()).filter(Boolean)});
}
