import {createHmac, timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';

const validService = /^[A-Za-z0-9][\w.-]*$/;
const validRepo = /^[\w.-]+\/[\w.-]+$/;

function docker(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, {timeout: 4000},
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function inspectService(service) {
  const format = '{"id":{{json .ID}},"name":{{json .Spec.Name}},"env":{{json .Spec.TaskTemplate.ContainerSpec.Env}}}';
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

export function createWebhookHandler({
  secret = readFileSync(process.env.WEBHOOK_SECRET_FILE, 'utf8').trim(),
  inspect = inspectService,
  restart = updateService
} = {}) {
  if (!secret) throw new Error('Configure WEBHOOK_SECRET_FILE');
  const deliveries = new Set();
  const reply = (res, status, message) => {
    res.writeHead(status, {'content-type': 'text/plain'});
    res.end(message);
  };

  return async (req, res) => {
    const service = req.params?.service;
    if (!validService.test(service || '')) return reply(res, 404, 'Not found');
    const body = req.rawBody;
    if (!Buffer.isBuffer(body)) return reply(res, 500, 'Runtime must enable BFAST_RAW_BODY=true');
    const signature = req.headers['x-hub-signature-256'];
    const expected = createHmac('sha256', secret).update(body).digest();
    if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature) ||
        !timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) {
      return reply(res, 401, 'Invalid signature');
    }
    if (req.headers['x-github-event'] !== 'push') return reply(res, 200, 'Event ignored');
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); }
    catch { return reply(res, 400, 'Invalid JSON'); }
    if (!payload || typeof payload !== 'object') return reply(res, 400, 'Invalid payload');
    const defaultBranch = payload.repository?.default_branch;
    if (typeof defaultBranch !== 'string' || !defaultBranch) return reply(res, 400, 'Missing default branch');
    if (payload.ref !== `refs/heads/${defaultBranch}` || payload.deleted) return reply(res, 200, 'Branch ignored');
    const repository = payload.repository?.full_name;
    if (typeof repository !== 'string' || !validRepo.test(repository)) return reply(res, 400, 'Invalid repository');
    const delivery = req.headers['x-github-delivery'];
    if (typeof delivery !== 'string' || !/^[a-f0-9-]{36}$/i.test(delivery)) return reply(res, 400, 'Invalid delivery ID');
    const deliveryKey = `${service}:${delivery}`;
    if (deliveries.has(deliveryKey)) return reply(res, 200, 'Already handled');
    deliveries.add(deliveryKey);
    let completed = false;
    try {
      const target = await inspect(service);
      if (target?.name !== service || typeof target?.id !== 'string' || !target.id) {
        return reply(res, 403, 'Exact service name required');
      }
      const env = Object.fromEntries((target.env || []).map(entry => {
        const index = entry.indexOf('=');
        return index < 0 ? [entry, ''] : [entry.slice(0, index), entry.slice(index + 1)];
      }));
      if ((env.MODE?.trim() || 'git') !== 'git') return reply(res, 403, 'Target service must use MODE=git');
      if (repositoryFromCloneUrl(env.GIT_CLONE_URL) !== repository.toLowerCase()) {
        return reply(res, 403, 'Repository does not match target service GIT_CLONE_URL');
      }
      await restart(target.id);
      completed = true;
      if (deliveries.size > 1000) deliveries.delete(deliveries.values().next().value);
      console.log(`Restart requested for ${service}: ${delivery}`);
      return reply(res, 200, 'Restart requested');
    } catch (error) {
      // Docker inspection includes environment secrets; never log its output or errors verbatim.
      console.error(`Docker inspection or restart failed for ${service}; code: ${error.code ?? 'unknown'}`);
      return reply(res, 500, 'Service inspection or restart failed');
    } finally {
      if (!completed) deliveries.delete(deliveryKey);
    }
  };
}
