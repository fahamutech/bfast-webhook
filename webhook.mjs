import {createHmac, timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';

const validService = /^[A-Za-z0-9][\w.-]*$/;
const validRepo = /^[\w.-]+\/[\w.-]+$/;
export const generationLabel = 'bfast.webhook.generation';
export const pausedLabel = 'bfast.webhook.paused';

function docker(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, {timeout: 4000},
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function inspectService(service) {
  const format = '{"id":{{json .ID}},"name":{{json .Spec.Name}},"env":{{json .Spec.TaskTemplate.ContainerSpec.Env}},"labels":{{json .Spec.Labels}}}';
  return JSON.parse(await docker(['service', 'inspect', '--format', format, service]));
}

function updateService(serviceId) {
  return docker(['service', 'update', '--force', '--detach=true', serviceId]);
}

export function repositoryFromCloneUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'github.com' ||
        url.port || url.search || url.hash) return null;
    const repo = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/i, '');
    return validRepo.test(repo) ? repo.toLowerCase() : null;
  } catch { return null; }
}

// Each service gets its own GitHub secret derived from the master webhook secret.
// Rotating bumps the service's generation label, which invalidates the old value.
export function serviceWebhookSecret(master, service, generation = 0) {
  return createHmac('sha256', master).update(`bfast-webhook:${service}:${generation}`).digest('hex');
}
export const webhookGeneration = labels => {
  const value = Number.parseInt(labels?.[generationLabel], 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

// In-memory delivery history shared by the webhook and the console. It resets when the service restarts.
export function createDeliveryLog({perService = 20, maxServices = 500, now = () => Date.now()} = {}) {
  const entries = new Map(), failures = new Map();
  const touch = (map, key, value) => {
    map.delete(key); map.set(key, value);
    if (map.size > maxServices) map.delete(map.keys().next().value);
  };
  return {
    record(service, entry) {
      const list = [{at: new Date(now()).toISOString(), ...entry}, ...(entries.get(service) || [])].slice(0, perService);
      touch(entries, service, list);
    },
    signatureFailure(service) {
      const current = failures.get(service) || {count: 0};
      touch(failures, service, {count: current.count + 1, last: new Date(now()).toISOString()});
    },
    get(service) { return {deliveries: entries.get(service) || [], signatureFailures: failures.get(service) || {count: 0, last: null}}; }
  };
}

const commitOf = payload => {
  const c = payload.head_commit;
  if (!c || typeof c !== 'object') return null;
  return {id: String(c.id || '').slice(0, 40), message: String(c.message || '').split('\n')[0].slice(0, 160),
    author: String(c.author?.username || c.author?.name || '').slice(0, 80), url: typeof c.url === 'string' && c.url.startsWith('https://github.com/') ? c.url : null};
};

export function createWebhookHandler({
  secret = readFileSync(process.env.WEBHOOK_SECRET_FILE, 'utf8').trim(),
  acceptSharedSecret = process.env.WEBHOOK_ACCEPT_SHARED_SECRET !== 'false',
  inspect = inspectService,
  restart = updateService,
  log = createDeliveryLog(),
  now = () => Date.now()
} = {}) {
  if (!secret) throw new Error('Configure WEBHOOK_SECRET_FILE');
  const deliveries = new Set();
  let lookups = [];
  const reply = (res, status, message) => {
    res.writeHead(status, {'content-type': 'text/plain'});
    res.end(message);
  };
  const matches = (key, body, signature) => timingSafeEqual(createHmac('sha256', key).update(body).digest(), Buffer.from(signature.slice(7), 'hex'));

  return async (req, res) => {
    const service = req.params?.service;
    if (!validService.test(service || '')) return reply(res, 404, 'Not found');
    const body = req.rawBody;
    if (!Buffer.isBuffer(body)) return reply(res, 500, 'Runtime must enable BFAST_RAW_BODY=true');
    const signature = req.headers['x-hub-signature-256'];
    if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) {
      log.signatureFailure(service);
      return reply(res, 401, 'Invalid signature');
    }

    // The shared secret is checked without touching Docker. Per-service secrets need the
    // service's generation label, so unverified lookups are rate limited.
    let target = null, verifiedBy = null;
    if (acceptSharedSecret && matches(secret, body, signature)) verifiedBy = 'shared';
    else {
      lookups = lookups.filter(t => now() - t < 60000);
      if (lookups.length >= 60) return reply(res, 429, 'Too many unverified deliveries');
      lookups.push(now());
      try { target = await inspect(service); } catch { log.signatureFailure(service); return reply(res, 401, 'Invalid signature'); }
      if (target?.name === service && matches(serviceWebhookSecret(secret, service, webhookGeneration(target.labels)), body, signature)) verifiedBy = 'service';
    }
    if (!verifiedBy) { log.signatureFailure(service); return reply(res, 401, 'Invalid signature'); }

    const event = req.headers['x-github-event'];
    const delivery = req.headers['x-github-delivery'];
    const deliveryId = typeof delivery === 'string' ? delivery.slice(0, 64) : null;
    const record = (result, status, reason, extra = {}) => log.record(service, {delivery: deliveryId, event: String(event || '').slice(0, 40), result, status, reason, secret: verifiedBy, ...extra});
    if (event === 'ping') { record('ping', 200, 'GitHub connected'); return reply(res, 200, 'Pong'); }
    if (event !== 'push') { record('ignored', 200, 'Event ignored'); return reply(res, 200, 'Event ignored'); }
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); }
    catch { record('rejected', 400, 'Invalid JSON'); return reply(res, 400, 'Invalid JSON'); }
    if (!payload || typeof payload !== 'object') { record('rejected', 400, 'Invalid payload'); return reply(res, 400, 'Invalid payload'); }
    const details = {branch: typeof payload.ref === 'string' ? payload.ref.replace(/^refs\/heads\//, '').slice(0, 120) : null, commit: commitOf(payload),
      pusher: typeof payload.pusher?.name === 'string' ? payload.pusher.name.slice(0, 80) : null};
    const defaultBranch = payload.repository?.default_branch;
    if (typeof defaultBranch !== 'string' || !defaultBranch) { record('rejected', 400, 'Missing default branch', details); return reply(res, 400, 'Missing default branch'); }
    if (payload.ref !== `refs/heads/${defaultBranch}` || payload.deleted) { record('ignored', 200, `Not the default branch (${defaultBranch})`, details); return reply(res, 200, 'Branch ignored'); }
    const repository = payload.repository?.full_name;
    if (typeof repository !== 'string' || !validRepo.test(repository)) { record('rejected', 400, 'Invalid repository', details); return reply(res, 400, 'Invalid repository'); }
    if (typeof delivery !== 'string' || !/^[a-f0-9-]{36}$/i.test(delivery)) { record('rejected', 400, 'Invalid delivery ID', details); return reply(res, 400, 'Invalid delivery ID'); }
    const deliveryKey = `${service}:${delivery}`;
    if (deliveries.has(deliveryKey)) return reply(res, 200, 'Already handled');
    deliveries.add(deliveryKey);
    let completed = false;
    try {
      target ||= await inspect(service);
      if (target?.name !== service || typeof target?.id !== 'string' || !target.id) {
        record('rejected', 403, 'Exact service name required', details);
        return reply(res, 403, 'Exact service name required');
      }
      const env = Object.fromEntries((target.env || []).map(entry => {
        const index = entry.indexOf('=');
        return index < 0 ? [entry, ''] : [entry.slice(0, index), entry.slice(index + 1)];
      }));
      if ((env.MODE?.trim() || 'git') !== 'git') { record('rejected', 403, 'Service does not use MODE=git', details); return reply(res, 403, 'Target service must use MODE=git'); }
      if (repositoryFromCloneUrl(env.GIT_CLONE_URL) !== repository.toLowerCase()) {
        record('rejected', 403, `Repository ${repository} does not match GIT_CLONE_URL`, details);
        return reply(res, 403, 'Repository does not match target service GIT_CLONE_URL');
      }
      if (target.labels?.[pausedLabel] === 'true') {
        completed = true;
        record('paused', 200, 'Auto-deploy is paused', details);
        return reply(res, 200, 'Auto-deploy paused');
      }
      await restart(target.id);
      completed = true;
      if (deliveries.size > 1000) deliveries.delete(deliveries.values().next().value);
      record('deployed', 200, 'Restart requested', details);
      console.log(`Restart requested for ${service}: ${delivery}`);
      return reply(res, 200, 'Restart requested');
    } catch (error) {
      // Docker inspection includes environment secrets; never log its output or errors verbatim.
      console.error(`Docker inspection or restart failed for ${service}; code: ${error.code ?? 'unknown'}`);
      record('failed', 500, 'Docker inspection or restart failed', details);
      return reply(res, 500, 'Service inspection or restart failed');
    } finally {
      if (!completed) deliveries.delete(deliveryKey);
    }
  };
}
