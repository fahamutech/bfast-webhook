import {createHmac, timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';

const validService = /^[A-Za-z0-9][\w.-]*$/;
const validRepo = /^[\w.-]+\/[\w.-]+$/;

function updateService(service) {
  return new Promise((resolve, reject) => {
    execFile('docker', ['service', 'update', '--force', '--detach=true', service],
      {timeout: 8000}, error => error ? reject(error) : resolve());
  });
}

export function createWebhookHandler({
  secret = readFileSync(process.env.WEBHOOK_SECRET_FILE, 'utf8').trim(),
  targets = JSON.parse(process.env.WEBHOOK_TARGETS_JSON || '{}'),
  restart = updateService
} = {}) {
  if (!secret || !targets || typeof targets !== 'object' || Array.isArray(targets) ||
      !Object.entries(targets).length ||
      !Object.entries(targets).every(([repo, service]) => validRepo.test(repo) &&
        typeof service === 'string' && validService.test(service))) {
    throw new Error('Configure WEBHOOK_SECRET_FILE and WEBHOOK_TARGETS_JSON');
  }
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
    const defaultBranch = payload.repository?.default_branch;
    if (typeof defaultBranch !== 'string' || !defaultBranch) return reply(res, 400, 'Missing default branch');
    if (payload.ref !== `refs/heads/${defaultBranch}` || payload.deleted) return reply(res, 200, 'Branch ignored');
    if (targets[payload.repository?.full_name] !== service) return reply(res, 403, 'Repository and service do not match');
    const delivery = req.headers['x-github-delivery'];
    if (typeof delivery !== 'string' || !/^[a-f0-9-]{36}$/i.test(delivery)) return reply(res, 400, 'Invalid delivery ID');
    if (deliveries.has(delivery)) return reply(res, 200, 'Already handled');
    deliveries.add(delivery);
    try {
      await restart(service);
      if (deliveries.size > 1000) deliveries.delete(deliveries.values().next().value);
      console.log(`Restart requested for ${service}: ${delivery}`);
      return reply(res, 200, 'Restart requested');
    } catch (error) {
      deliveries.delete(delivery);
      console.error(`Restart failed for ${service}:`, error);
      return reply(res, 500, 'Restart failed');
    }
  };
}
