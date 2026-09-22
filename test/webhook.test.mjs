import assert from 'node:assert/strict';
import {createHmac, randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {createWebhookHandler, repositoryFromCloneUrl} from '../webhook.mjs';

const secret = 'test-secret';
const service = {
  id: 'service-id', name: 'example_faas',
  env: ['MODE=git', 'GIT_CLONE_URL=https://github.com/example/functions.git']
};

function setup(target = service) {
  const calls = {inspect: [], restart: []};
  const handler = createWebhookHandler({
    secret,
    inspect: async name => { calls.inspect.push(name); return target; },
    restart: async id => { calls.restart.push(id); }
  });
  return {handler, calls};
}

async function send(handler, {
  name = 'example_faas', repo = 'example/functions', branch = 'main',
  ref = `refs/heads/${branch}`, deleted = false, signed = true,
  event = 'push', delivery = randomUUID()
} = {}) {
  // Whitespace and Unicode ensure the signature uses exact bytes, not reserialized JSON.
  const body = Buffer.from(JSON.stringify({
    repository: {full_name: repo, default_branch: branch}, ref, deleted, note: 'café'
  }, null, 2) + '\n');
  const req = {params: {service: name}, rawBody: body, headers: {
    'x-github-event': event, 'x-github-delivery': delivery,
    'x-hub-signature-256': signed
      ? 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') : 'invalid'
  }};
  const res = {writeHead(status) {this.status = status;}, end(body) {this.body = body;}};
  await handler(req, res);
  return res;
}

test('normalizes GitHub clone URLs and rejects misleading hosts', () => {
  for (const url of ['https://github.com/Example/Functions.git',
    'https://github.com/example/functions/', 'http://github.com/example/functions.git/',
    'https://user:password@github.com/example/functions.git']) {
    assert.equal(repositoryFromCloneUrl(url), 'example/functions');
  }
  for (const url of [undefined, 'https://github.com.evil.test/example/functions.git',
    'https://github.com@evil.test/example/functions.git', 'https://other.test/example/functions',
    'https://github.com/example/functions/tree/main', 'https://github.com/example/functions?x=1']) {
    assert.equal(repositoryFromCloneUrl(url), null);
  }
});

test('inspects the named service and restarts its ID without a target list', async () => {
  const {handler, calls} = setup();
  assert.equal((await send(handler, {repo: 'Example/Functions'})).status, 200);
  assert.deepEqual(calls, {inspect: ['example_faas'], restart: ['service-id']});
});

test('does not inspect Docker for invalid signatures, other events, branches or deletions', async () => {
  const {handler, calls} = setup();
  assert.equal((await send(handler, {signed: false})).status, 401);
  await send(handler, {event: 'ping'});
  await send(handler, {ref: 'refs/heads/feature'});
  await send(handler, {deleted: true});
  assert.deepEqual(calls, {inspect: [], restart: []});
});

test('rejects a different repository, non-Git mode, missing URL and service-name aliases', async () => {
  for (const target of [
    {...service, env: ['MODE=git', 'GIT_CLONE_URL=https://github.com/other/functions.git']},
    {...service, env: ['MODE=npm', 'GIT_CLONE_URL=https://github.com/example/functions.git']},
    {...service, env: []},
    {...service, name: 'another-service'}
  ]) {
    const {handler, calls} = setup(target);
    assert.equal((await send(handler)).status, 403);
    assert.deepEqual(calls.restart, []);
  }
});

test('accepts the runtime default Git mode and any default branch name', async () => {
  const {handler, calls} = setup({...service, env: service.env.slice(1)});
  for (const branch of ['main', 'master', 'release/current']) {
    assert.equal((await send(handler, {branch})).status, 200);
  }
  assert.equal(calls.restart.length, 3);
});

test('deduplicates each service delivery and permits retry after Docker failure', async () => {
  let fail = true;
  let restarts = 0;
  const handler = createWebhookHandler({secret, inspect: async () => service, restart: async () => {
    if (fail) throw new Error('Docker unavailable');
    restarts++;
  }});
  const delivery = randomUUID();
  assert.equal((await send(handler, {delivery})).status, 500);
  fail = false;
  assert.equal((await send(handler, {delivery})).status, 200);
  assert.equal((await send(handler, {delivery})).body, 'Already handled');
  assert.equal(restarts, 1);
});

test('Docker inspection failure never restarts the service', async () => {
  let restarts = 0;
  const handler = createWebhookHandler({secret,
    inspect: async () => {throw new Error('Service does not exist');},
    restart: async () => {restarts++;}
  });
  assert.equal((await send(handler)).status, 500);
  assert.equal(restarts, 0);
});
