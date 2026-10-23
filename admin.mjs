import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dockerRequest, demuxLogs, filters, fail} from './docker.mjs';
import {createFirebaseVerifier, createSessions, parseAccess, serializeUsers, usersInput, normalizeEmail, validEmail} from './auth.mjs';
import {classify, parseMountRoots, placementChanges, serviceSummary, serviceDetail, taskSummary, updatedSpec, actionSpec, newServiceSpec, nodeSummary, checkEnv, parseImages} from './services.mjs';
import {secretReference, secretChoices, newSecret, secretAttachments} from './secrets.mjs';
import {serviceWebhookSecret, webhookGeneration, generationLabel, pausedLabel, repositoryFromCloneUrl, createDeliveryLog} from './webhook.mjs';

export const defaultFirebaseConfig = {projectId: 'bfastapp', appId: '1:311831913786:web:6be76738b599546b',
  apiKey: 'AIzaSyBNnvwleeyFislflOkB-6RFNvo7w1FI3ko', authDomain: 'bfastapp.firebaseapp.com', messagingSenderId: '311831913786'};
const withUsers = (list, users) => { const serialized = serializeUsers(users); return [...list.filter(x => !x.startsWith("SERVICE_USERS=")), ...(serialized ? [`SERVICE_USERS=${serialized}`] : [])]; };
const envMap = list => Object.fromEntries((list || []).map(e => { const i = e.indexOf('='); return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)]; }));
const asset = file => readFileSync(new URL(`./admin/${file}`, import.meta.url), 'utf8');

export function createAdmin({jwtSecret, origin, docker = dockerRequest, excluded = [], allowedMountRoots = '', verifyIdToken, firebaseConfig = defaultFirebaseConfig,
  adminEmails = '', serviceUsers = '', selfName = 'webhook', cluster = '', hostDomain = '',
  defaultImage = 'joshuamshana/bfastfunction:latest', allowedImages = '', sessionMinutes = 60, sessionMaxHours = 12, contactEmail = 'mama27j@gmail.com', webhookSecret = '', acceptSharedSecret = true, deliveryLog = createDeliveryLog(),
  now = () => Date.now()} = {}) {
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('ADMIN_JWT_SECRET_FILE must hold a 32+ character signing key');
  if (!origin || new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('ADMIN_ORIGIN must be an exact HTTPS origin');
  if (!parseAccess(adminEmails).admins.size) throw new Error('ADMIN_EMAILS must list at least one Google account');
  const verify = verifyIdToken || createFirebaseVerifier(firebaseConfig.projectId);
  const sessions = createSessions({jwtSecret, origin, now, ttl: Math.round(sessionMinutes * 60), renewAfter: Math.max(60, Math.round(sessionMinutes * 15)), maxAge: Math.round(sessionMaxHours * 3600)});
  const authHost = `https://${firebaseConfig.authDomain}`, originHost = new URL(origin).host;
  const headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; script-src 'self' https://www.gstatic.com https://apis.google.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com ${authHost}; frame-src ${authHost} https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`};
  let attempts = [], mutation = false, accessCache = {at: 0, access: null, self: null, images: [], signouts: new Map()};
  // Durable sign-out: "sessions valid after" times per user, stored as labels on this service so they survive
  // restarts. Label-only updates do not restart tasks. Keys use a hash so emails never appear in labels.
  const signoutPrefix = 'bfast.session.after.';
  const signoutKey = email => signoutPrefix + createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 32);
  const localSignouts = new Map();
  const readSignouts = labels => new Map(Object.entries(labels || {}).filter(([k, v]) => k.startsWith(signoutPrefix) && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)]));
  const signedOutAt = email => { const k = signoutKey(email); return Math.max(accessCache.signouts?.get(k) || 0, localSignouts.get(k) || 0); };
  async function endSessions(email) {
    const k = signoutKey(email), at = now();
    localSignouts.set(k, at);
    for (const [key, value] of localSignouts) if (value < at - sessions.ttl * 1000) localSignouts.delete(key);
    for (let attempt = 0; attempt < 3; attempt++) {
      const {self} = await loadAccess(true);
      if (!self) return false;
      const spec = structuredClone(self.Spec);
      spec.Labels ||= {};
      // Tokens issued before a sign-out expire within one session lifetime, so older entries can go.
      for (const [key, value] of Object.entries(spec.Labels)) if (key.startsWith(signoutPrefix) && Number(value) < at - sessions.ttl * 1000) delete spec.Labels[key];
      spec.Labels[k] = String(at);
      try {
        await docker('POST', `/services/${self.ID}/update?version=${self.Version.Index}`, spec);
        accessCache = {at: 0, access: null, self: null, images: [], signouts: new Map()};
        return true;
      } catch (error) { if (error.status !== 409) return false; }
    }
    return false;
  }
  const options = () => ({excluded, selfName});
  const mountRoots = parseMountRoots(allowedMountRoots);

  // Access policy lives in this service's own environment; read it live so user changes apply before the restart lands.
  async function loadAccess(force = false) {
    if (!force && accessCache.access && now() - accessCache.at < 5000) return accessCache;
    let self = null, access;
    try {
      const matches = await docker('GET', `/services?filters=${filters({name: [selfName]})}`);
      self = matches.find(s => s.Spec?.Name === selfName) || null;
    } catch { self = null; }
    let images = parseImages(allowedImages);
    if (self) { const e = envMap(self.Spec.TaskTemplate.ContainerSpec.Env); access = parseAccess(e.ADMIN_EMAILS ?? adminEmails, e.SERVICE_USERS ?? ''); if (e.ALLOWED_IMAGES !== undefined) images = parseImages(e.ALLOWED_IMAGES); }
    else access = parseAccess(adminEmails, serviceUsers);
    if (!access.admins.size) access = parseAccess(adminEmails, serviceUsers);
    accessCache = {at: now(), access, self, images, signouts: readSignouts(self?.Spec?.Labels)};
    return accessCache;
  }
  const roleOf = (access, email) => access.admins.has(email) ? 'admin' : access.users.has(email) ? 'user' : null;
  const canSee = (access, email, service) => {
    const kind = classify(service, options());
    if (access.admins.has(email)) return kind === 'app' || kind === 'control';
    return kind === 'app' && Boolean(access.users.get(email)?.has(service.Spec.Name));
  };

  const wrap = (action, {publicRoute = false, write = false, admin = false} = {}) => async (req, res) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    try {
      if (write && (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))) throw fail(403, 'Same-origin JSON request required');
      let user = null;
      if (!publicRoute) {
        const claims = await sessions.verify(req.headers.cookie);
        const {access, images} = await loadAccess();
        if (claims.t <= signedOutAt(claims.email)) throw fail(401, 'Your session was ended. Sign in again.');
        if (write && req.headers['x-csrf-token'] !== claims.csrf) throw fail(403, 'Invalid request token');
        const role = roleOf(access, claims.email);
        if (!role) throw fail(401, 'Your access was removed. Sign in again.');
        if (admin && role !== 'admin') throw fail(403, 'Administrator access required');
        user = {email: claims.email, name: claims.name, picture: claims.picture, role, claims, access, images};
        // Silent renewal: active sessions get a fresh cookie, up to the absolute limit.
        const fresh = await sessions.renew(claims);
        if (fresh) res.setHeader('Set-Cookie', sessions.cookie(fresh.token, fresh.maxAge));
      }
      await action(req, res, user);
    } catch (error) {
      if (!error.status) console.error(`Admin operation failed: ${error.code || error.message || 'unknown'}`);
      res.status(error.status || 502).json({error: error.status ? error.message : 'Service operation failed'});
    }
  };
  const locked = fn => async (...args) => {
    if (mutation) throw fail(409, 'Another update is in progress. Try again shortly.');
    mutation = true;
    try { return await fn(...args); } finally { mutation = false; }
  };
  const inspect = async (id, user, {kinds = ['app', 'control']} = {}) => {
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(id || '')) throw fail(404, 'Service unavailable');
    const service = await docker('GET', `/services/${encodeURIComponent(id)}`);
    if (!canSee(user.access, user.email, service)) throw fail(403, 'You do not have access to this service');
    const kind = classify(service, options());
    if (!kinds.includes(kind)) throw fail(403, kind === 'control' ? 'The management service only supports environment, image and restart changes' : 'Protected service');
    return Object.assign(service, {kind});
  };
  const tasksFor = async ids => ids.length ? docker('GET', `/tasks?filters=${filters({service: ids})}`) : [];
  const nodeNames = async () => { try { return new Map((await docker('GET', '/nodes')).map(n => [n.ID, n.Description?.Hostname || n.ID])); } catch { return new Map(); } };
  const updateSelf = async (self, mutate) => {
    const spec = structuredClone(self.Spec); mutate(spec);
    spec.TaskTemplate.ForceUpdate = (spec.TaskTemplate.ForceUpdate || 0) + 1;
    const result = await docker('POST', `/services/${self.ID}/update?version=${self.Version.Index}`, spec);
    accessCache = {at: 0, access: null, self: null};
    return result;
  };
  const isAppOnly = s => classify(s, options()) === 'app';
  const webhookView = service => {
    const name = service.Spec.Name, variables = envMap(service.Spec.TaskTemplate.ContainerSpec.Env), labels = service.Spec.Labels || {};
    const repository = repositoryFromCloneUrl(variables.GIT_CLONE_URL), mode = variables.MODE?.trim() || 'git', problems = [];
    if (!webhookSecret) problems.push('WEBHOOK_SECRET_FILE is not set on the management service.');
    if (mode !== 'git') problems.push(`MODE is "${mode}". Only MODE=git services redeploy from GitHub pushes.`);
    if (mode === 'git' && !repository) problems.push('GIT_CLONE_URL is missing or is not a github.com repository URL.');
    const generation = webhookGeneration(labels);
    return {service: name, version: service.Version.Index, url: `${origin}/github-webhook/${encodeURIComponent(name)}`, contentType: 'application/json', events: ['push'],
      repository, settingsUrl: repository ? `https://github.com/${repository}/settings/hooks` : null,
      ready: !problems.length, problems, paused: labels[pausedLabel] === 'true', generation, sharedSecretAccepted: acceptSharedSecret,
      secret: webhookSecret ? serviceWebhookSecret(webhookSecret, name, generation) : null, ...deliveryLog.get(name)};
  };

  return {
    // Sessions and sign-in only work on ADMIN_ORIGIN, so other hostnames routed here (older aliases) redirect to it.
    page: wrap(async (req, res) => {
      if (req.headers.host && req.headers.host.toLowerCase() !== originHost) return res.redirect(301, `${origin}/admin`);
      res.type('html').send(asset('index.html'));
    }, {publicRoute: true}),
    script: wrap(async (_, res) => res.type('js').send(asset('app.js')), {publicRoute: true}),
    style: wrap(async (_, res) => res.type('css').send(asset('style.css')), {publicRoute: true}),
    config: wrap(async (_, res) => res.json({firebase: firebaseConfig, contactEmail, defaults: {cluster, hostDomain, image: defaultImage}}), {publicRoute: true}),
    login: wrap(async (req, res) => {
      attempts = attempts.filter(t => now() - t < 60000);
      if (attempts.length >= 30) { res.setHeader('Retry-After', '60'); throw fail(429, 'Too many sign-in attempts. Try again in a minute.'); }
      attempts.push(now());
      if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).some(k => k !== 'idToken')) throw fail(400, 'Provide idToken');
      const account = await verify(req.body.idToken);
      const {access} = await loadAccess(true);
      const role = roleOf(access, account.email);
      if (!role) throw fail(403, `${account.email} has no services assigned. Ask an administrator for access.`);
      const {token, csrf} = await sessions.issue(account);
      res.setHeader('Set-Cookie', sessions.cookie(token, sessions.ttl));
      res.json({csrf, user: {email: account.email, name: account.name, picture: account.picture, role}});
    }, {publicRoute: true, write: true}),
    session: wrap(async (_, res, u) => res.json({csrf: u.claims.csrf, user: {email: u.email, name: u.name, picture: u.picture, role: u.role}, defaults: {cluster, hostDomain, image: u.images.length && !u.images.includes(defaultImage) ? u.images[0] : defaultImage, images: u.role === 'admin' ? (u.images.length ? u.images : [defaultImage]) : []}})),
    // Signing out ends every session of this account, on all devices, and survives restarts.
    logout: wrap(async (_, res, u) => {
      sessions.revoke(u.claims);
      const durable = await endSessions(u.email);
      res.setHeader('Set-Cookie', sessions.cookie('', 0));
      res.json({ok: true, everywhere: durable});
    }, {write: true}),
    endSessions: wrap(async (req, res, u) => {
      if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).some(k => k !== 'email')) throw fail(400, 'Provide email');
      const email = normalizeEmail(req.body.email);
      if (!validEmail(email)) throw fail(400, 'Invalid email');
      const durable = await endSessions(email);
      res.json({ok: true, durable, message: `Sessions for ${email} ended${durable ? '' : ' until the management service restarts (it could not be updated)'}.${email === u.email ? ' Sign in again to continue.' : ''}`});
    }, {write: true, admin: true}),

    list: wrap(async (_, res, u) => {
      const services = (await docker('GET', '/services')).filter(s => canSee(u.access, u.email, s));
      const tasks = await tasksFor(services.map(s => s.ID));
      res.json(services.map(s => serviceSummary(s, tasks.filter(t => t.ServiceID === s.ID && t.DesiredState === 'running'), classify(s, options())))
        .sort((a, b) => (a.kind === 'control') - (b.kind === 'control') || a.name.localeCompare(b.name)));
    }),
    detail: wrap(async (req, res, u) => {
      const service = await inspect(req.params.service, u);
      const [tasks, nodes] = await Promise.all([tasksFor([service.ID]), nodeNames()]);
      const nodeOptions = u.role === 'admin' && service.kind !== 'control' ? [...nodes.values()].sort() : [];
      const summary = serviceSummary(service, tasks.filter(t => t.DesiredState === 'running'), service.kind);
      const current = service.Spec.TaskTemplate.ContainerSpec.Image;
      res.json({...serviceDetail(service), ...summary, kind: service.kind, canEditSettings: u.role === 'admin',
        canEditPlacement: u.role === 'admin' && service.kind !== 'control', nodeOptions, mountRoots: u.role === 'admin' ? mountRoots : [],
        imageOptions: u.role === 'admin' ? [...new Set([current, ...u.images])] : [],
        users: u.role === 'admin' ? [...u.access.users.entries()].filter(([, s]) => s.has(service.Spec.Name)).map(([email]) => email) : undefined,
        secrets: (service.Spec.TaskTemplate.ContainerSpec.Secrets || []).map(secretReference),
        tasks: tasks.map(t => taskSummary(t, nodes)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 25)});
    }),
    tasks: wrap(async (req, res, u) => {
      const service = await inspect(req.params.service, u);
      const [tasks, nodes] = await Promise.all([tasksFor([service.ID]), nodeNames()]);
      res.json(tasks.map(t => taskSummary(t, nodes)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 25));
    }),
    logs: wrap(async (req, res, u) => {
      const service = await inspect(req.params.service, u);
      const tail = Math.min(1000, Math.max(10, Number.parseInt(req.query?.tail, 10) || 200));
      const raw = await docker('GET', `/services/${service.ID}/logs?stdout=true&stderr=true&timestamps=true&tail=${tail}`, undefined, {raw: true, timeout: 15000, limit: 2_000_000});
      const text = demuxLogs(raw);
      res.json({tail, lines: text.split('\n').filter(Boolean).slice(-tail)});
    }),
    update: wrap(locked(async (req, res, u) => {
      if ((JSON.stringify(req.body) || '').length > 1048576) throw fail(413, 'Settings too large');
      const service = await inspect(req.params.service, u);
      // Placement, storage, hostnames and rollout order are administrator settings. Values sent back unchanged are ignored.
      const changed = placementChanges(service, req.body);
      if (changed.length) {
        if (u.role !== 'admin') throw fail(403, 'Only administrators can change placement, storage, hostnames or the rollout order');
        if (service.kind === 'control') throw fail(400, 'Placement and storage of the management service cannot be changed here');
      }
      const spec = updatedSpec(service, req.body, {allowImage: u.role === 'admin', mountRoots});
      // Resource allocation and images are administrator decisions; users may only resend the current values.
      if (u.role !== 'admin') {
        const now = serviceDetail(service);
        if (['replicas', 'cpus', 'memoryMB', 'restart'].some(k => req.body[k] !== now[k])) throw fail(403, 'Only administrators can change replicas, limits or the restart policy');
      }
      const image = req.body.image;
      if (image !== undefined && image !== service.Spec.TaskTemplate.ContainerSpec.Image) {
        if (!u.images.length) throw fail(400, 'Image changes are disabled. Add images to ALLOWED_IMAGES on the management service.');
        if (!u.images.includes(image)) throw fail(400, 'Choose an image from ALLOWED_IMAGES');
      }
      if (service.kind === 'control') {
        if (req.body.secrets !== undefined) throw fail(400, 'Secrets of the management service cannot be edited here');
        if (spec.Mode.Replicated.Replicas < 1) throw fail(400, 'The management service must keep at least one replica');
        const e = envMap(spec.TaskTemplate.ContainerSpec.Env);
        for (const key of ['ADMIN_JWT_SECRET_FILE', 'ADMIN_ORIGIN', 'WEBHOOK_SECRET_FILE']) if (!e[key]) throw fail(400, `${key} is required for the management service`);
        if (!parseAccess(e.ADMIN_EMAILS).admins.has(u.email)) throw fail(400, 'ADMIN_EMAILS must keep your own account so you are not locked out');
      } else if (req.body.secrets !== undefined) {
        const choices = await secretChoices(docker, service, isAppOnly);
        spec.TaskTemplate.ContainerSpec.Secrets = secretAttachments(service, req.body.secrets, choices);
      }
      const result = await docker('POST', `/services/${service.ID}/update?version=${service.Version.Index}`, spec);
      if (service.kind === 'control') accessCache = {at: 0, access: null, self: null};
      res.json({ok: true, message: service.kind === 'control' ? 'Update accepted. The management service restarts in a few seconds; reload this page afterwards.' : 'Update accepted. Swarm is rolling out the new configuration.', warnings: result.Warnings || []});
    }), {write: true}),
    action: wrap(locked(async (req, res, u) => {
      const action = req.body?.action;
      if (!['archive', 'unarchive', 'restart'].includes(action)) throw fail(400, 'Unknown action');
      const service = await inspect(req.params.service, u);
      if (service.kind === 'control' && action !== 'restart') throw fail(400, 'The management service can only be restarted');
      const spec = actionSpec(service, action);
      const result = await docker('POST', `/services/${service.ID}/update?version=${service.Version.Index}`, spec);
      const text = {archive: 'Archived (scaled to 0 replicas)', unarchive: 'Unarchived (scaled to 1 replica)', restart: 'Restart requested'}[action];
      res.json({ok: true, message: `${text}: ${service.Spec.Name}`, warnings: result.Warnings || []});
    }), {write: true}),
    webhook: wrap(async (req, res, u) => {
      const service = await inspect(req.params.service, u);
      res.json(webhookView(service));
    }),
    webhookAction: wrap(locked(async (req, res, u) => {
      if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).some(k => !['action', 'version'].includes(k))) throw fail(400, 'Provide action and version');
      const {action, version} = req.body;
      if (!['rotate', 'pause', 'resume'].includes(action)) throw fail(400, 'Unknown action');
      const service = await inspect(req.params.service, u);
      if (version !== service.Version.Index) throw fail(409, 'Service changed. Reload before saving.');
      if (action === 'rotate' && !webhookSecret) throw fail(503, 'WEBHOOK_SECRET_FILE is not configured');
      // Label-only change: Swarm updates the service without replacing its tasks.
      const spec = structuredClone(service.Spec);
      spec.Labels ||= {};
      if (action === 'rotate') spec.Labels[generationLabel] = String(webhookGeneration(spec.Labels) + 1);
      else if (action === 'pause') spec.Labels[pausedLabel] = 'true';
      else delete spec.Labels[pausedLabel];
      await docker('POST', `/services/${service.ID}/update?version=${service.Version.Index}`, spec);
      const updated = await docker('GET', `/services/${service.ID}`);
      res.json({...webhookView(Object.assign(updated, {kind: service.kind})), message: {rotate: 'Secret rotated. Paste the new secret into the GitHub webhook settings; the old one stops working now.', pause: 'Auto-deploy paused. Pushes are recorded but do not restart the service.', resume: 'Auto-deploy resumed.'}[action]});
    }), {write: true}),
    secrets: wrap(async (req, res, u) => {
      const service = await inspect(req.params.service, u, {kinds: ['app']});
      res.json(await secretChoices(docker, service, isAppOnly));
    }),
    createSecret: wrap(locked(async (req, res, u) => {
      const service = await inspect(req.params.service, u, {kinds: ['app']});
      const spec = newSecret(service, req.body);
      const result = await docker('POST', '/secrets/create', spec);
      res.status(201).json({id: result.ID, name: spec.Name});
    }), {write: true}),

    create: wrap(locked(async (req, res, u) => {
      if ((JSON.stringify(req.body) || '').length > 1048576) throw fail(413, 'Settings too large');
      const {users, ...input} = req.body || {};
      const spec = newServiceSpec(input, {cluster, hostDomain, defaultImage, images: u.images});
      if (classify({Spec: spec}, options()) !== 'app') throw fail(400, 'That name is reserved for infrastructure');
      const existing = await docker('GET', `/services?filters=${filters({name: [spec.Name]})}`);
      if (existing.some(s => s.Spec?.Name === spec.Name)) throw fail(409, `${spec.Name} already exists`);
      const assigned = users === undefined ? [] : users;
      if (!Array.isArray(assigned) || assigned.length > 50) throw fail(400, 'Invalid user list');
      const emails = assigned.map(normalizeEmail);
      if (emails.some(e => !/^[^\s@;:,]+@[^\s@;:,]+\.[^\s@;:,]+$/.test(e))) throw fail(400, 'Invalid user email');
      const result = await docker('POST', '/services/create', spec);
      let warning = '';
      if (emails.length) {
        const {self} = await loadAccess(true);
        if (!self) warning = ' Users were not assigned because the management service could not be found.';
        else await updateSelf(self, s => {
          const e = envMap(s.TaskTemplate.ContainerSpec.Env), access = parseAccess('', e.SERVICE_USERS);
          for (const email of emails) access.users.set(email, new Set([...(access.users.get(email) || []), spec.Name]));
          s.TaskTemplate.ContainerSpec.Env = withUsers(s.TaskTemplate.ContainerSpec.Env, access.users);
        });
      }
      res.status(201).json({id: result.ID, name: spec.Name, hosts: [...spec.Labels[`traefik.http.routers.${input.project}-faas.rule`].matchAll(/`([^`]+)`/g)].map(m => m[1]),
        message: `${spec.Name} created with ${spec.Mode.Replicated.Replicas} replica(s).${emails.length && !warning ? ' Users assigned; the management service restarts shortly.' : ''}${warning}`, warnings: result.Warnings || []});
    }), {write: true, admin: true}),

    swarm: wrap(async (_, res) => {
      const [info, nodes, services, tasks] = await Promise.all([docker('GET', '/info'), docker('GET', '/nodes'), docker('GET', '/services'), docker('GET', `/tasks?filters=${filters({'desired-state': ['running']})}`)]);
      res.json({swarm: {state: info.Swarm?.LocalNodeState || 'unknown', nodes: info.Swarm?.Nodes ?? nodes.length, managers: info.Swarm?.Managers ?? 0, clusterId: info.Swarm?.Cluster?.ID || null,
        engine: info.ServerVersion || '', cpus: info.NCPU || 0, memoryGB: Math.round((info.MemTotal || 0) / 1073741824 * 10) / 10, containersRunning: info.ContainersRunning ?? null, images: info.Images ?? null},
        nodes: nodes.map(nodeSummary), services: services.map(s => serviceSummary(s, tasks.filter(t => t.ServiceID === s.ID), classify(s, options()))).sort((a, b) => a.name.localeCompare(b.name))});
    }, {admin: true}),
    users: wrap(async (_, res, u) => {
      const {self} = await loadAccess(true);
      const names = (await docker('GET', '/services')).filter(isAppOnly).map(s => s.Spec.Name).sort();
      res.json({admins: [...u.access.admins], users: [...u.access.users.entries()].map(([email, services]) => ({email, services: [...services]})), services: names,
        version: self?.Version?.Index ?? null, manageable: Boolean(self), selfName});
    }, {admin: true}),
    saveUsers: wrap(locked(async (req, res, u) => {
      if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).some(k => !['users', 'version'].includes(k))) throw fail(400, 'Provide users');
      const users = usersInput(req.body.users);
      for (const email of users.keys()) if (u.access.admins.has(email)) throw fail(400, `${email} is already an administrator`);
      const {self} = await loadAccess(true);
      if (!self) throw fail(503, `Management service "${selfName}" was not found in Swarm, so users cannot be stored. Set SELF_SERVICE_NAME.`);
      if (req.body.version !== undefined && req.body.version !== self.Version.Index) throw fail(409, 'User list changed. Reload before saving.');
      await updateSelf(self, s => { checkEnv(s.TaskTemplate.ContainerSpec.Env = withUsers(s.TaskTemplate.ContainerSpec.Env, users)); });
      res.json({ok: true, message: 'Users saved. Access applies now; the management service restarts in a few seconds.'});
    }), {write: true, admin: true})
  };
}

export const adminRoutes = ['page', 'script', 'style', 'config', 'login', 'session', 'logout', 'endSessions', 'list', 'detail', 'tasks', 'logs', 'update', 'action', 'secrets', 'createSecret', 'webhook', 'webhookAction', 'create', 'swarm', 'users', 'saveUsers'];

export function configuredAdmin(env = process.env, {deliveryLog} = {}) {
  if (!env.ADMIN_JWT_SECRET_FILE || !env.ADMIN_ORIGIN || !env.ADMIN_EMAILS) {
    const disabled = (_, res) => res.status(503).json({error: 'Service manager is not configured: set ADMIN_JWT_SECRET_FILE, ADMIN_ORIGIN and ADMIN_EMAILS'});
    return Object.fromEntries(adminRoutes.map(k => [k, disabled]));
  }
  let firebaseConfig = defaultFirebaseConfig;
  if (env.FIREBASE_WEB_CONFIG) {
    firebaseConfig = JSON.parse(env.FIREBASE_WEB_CONFIG);
    for (const key of ['projectId', 'apiKey', 'authDomain', 'appId']) if (typeof firebaseConfig[key] !== 'string') throw new Error(`FIREBASE_WEB_CONFIG needs ${key}`);
  }
  return createAdmin({jwtSecret: readFileSync(env.ADMIN_JWT_SECRET_FILE, 'utf8').trim(), origin: env.ADMIN_ORIGIN, firebaseConfig,
    adminEmails: env.ADMIN_EMAILS, serviceUsers: env.SERVICE_USERS || '', selfName: env.SELF_SERVICE_NAME || 'webhook',
    cluster: env.SWARM_CLUSTER || '', hostDomain: env.SWARM_HOST_DOMAIN || '', defaultImage: env.DEFAULT_IMAGE || 'joshuamshana/bfastfunction:latest', allowedImages: env.ALLOWED_IMAGES || '',
    sessionMinutes: Math.min(720, Math.max(5, Number(env.SESSION_MINUTES) || 60)), sessionMaxHours: Math.min(168, Math.max(1, Number(env.SESSION_MAX_HOURS) || 12)), contactEmail: env.SITE_CONTACT_EMAIL || 'mama27j@gmail.com',
    webhookSecret: env.WEBHOOK_SECRET_FILE ? readFileSync(env.WEBHOOK_SECRET_FILE, 'utf8').trim() : '', acceptSharedSecret: env.WEBHOOK_ACCEPT_SHARED_SECRET !== 'false', deliveryLog,
    excluded: (env.ADMIN_EXCLUDED_SERVICES || '').split(',').map(s => s.trim()).filter(Boolean), allowedMountRoots: env.ADMIN_ALLOWED_MOUNT_ROOTS || ''});
}
