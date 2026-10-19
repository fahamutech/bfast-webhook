import assert from 'node:assert/strict';
import {test} from 'node:test';
import express from 'express';
import {createSite, renderMarkdown, docs} from '../site.mjs';

async function setup(t, options = {}) {
  const fetched = []; let clock = Date.now(); let fail = false;
  const site = createSite({now: () => clock, fetchText: async url => { fetched.push(url); if (fail) throw new Error('offline'); return `# Title\n\nSee [spec](./docs/function-spec.md) and [env](docs/missing.md#x).\n\n## Install\n\n\`\`\`bash\nnpm i\n\`\`\`\n\n<script>alert(1)</script>\n`; }, ...options});
  const app = express();
  app.get('/', site.home); app.get('/site/:file', site.asset); app.get('/docs', site.docs); app.get('/docs/:doc', site.docs);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const get = async path => { const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`); return {status: res.status, headers: res.headers, text: await res.text()}; };
  return {get, fetched, advance: ms => { clock += ms; }, offline: () => { fail = true; }};
}

test('home page is served with sign-up links, CSP and cacheable assets', async t => {
  const s = await setup(t, {registerUrl: 'https://cloud.example.com/register'});
  const home = await s.get('/');
  assert.equal(home.status, 200); assert.match(home.text, /Push your functions\./); assert.match(home.text, /href="https:\/\/cloud\.example\.com\/register"/);
  assert.doesNotMatch(home.text, /\{\{/); assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  for (const file of ['site.css', 'site.js', 'docs.js', 'favicon.svg']) assert.equal((await s.get('/site/' + file)).status, 200);
  assert.equal((await s.get('/site/..%2Fadmin.mjs')).status, 404); assert.equal((await s.get('/site/index.html')).status, 404);
  const fallback = await (await setup(t)).get('/'); assert.match(fallback.text, /mailto:mama27j@gmail\.com\?subject=BFast%20Cloud%20early%20access%20request/);
});

test('docs render GitHub markdown with rewritten links, escaped HTML, TOC and caching', async t => {
  const s = await setup(t);
  const page = await s.get('/docs/functions');
  assert.equal(page.status, 200);
  assert.deepEqual(s.fetched, ['https://raw.githubusercontent.com/fahamutech/bfast-functions/HEAD/README.md']);
  assert.match(page.text, /href="\/docs\/function-spec"/);
  assert.match(page.text, /href="https:\/\/github\.com\/fahamutech\/bfast-functions\/blob\/HEAD\/docs\/missing\.md#x"/);
  assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.doesNotMatch(page.text, /<script>alert/);
  assert.match(page.text, /<a href="#install" class="toc-2">Install<\/a>/); assert.match(page.text, /aria-current="page">Overview/);
  assert.match(page.text, /View source on GitHub/);
  await s.get('/docs/functions'); assert.equal(s.fetched.length, 1);
  s.advance(16 * 60 * 1000); s.offline();
  const stale = await s.get('/docs/functions'); assert.equal(stale.status, 200); assert.match(stale.text, /showing cached copy/); assert.equal(s.fetched.length, 2);
});

test('docs index shows the local getting started guide; unknown and offline pages degrade gracefully', async t => {
  const s = await setup(t);
  const index = await s.get('/docs'); assert.equal(index.status, 200); assert.match(index.text, /Install the CLI/); assert.equal(s.fetched.length, 0);
  assert.equal((await s.get('/docs/nope')).status, 404);
  s.offline(); const offline = await s.get('/docs/cli'); assert.equal(offline.status, 200); assert.match(offline.text, /could not be loaded from GitHub/);
});

test('markdown renderer rejects unsafe links and images and resolves relative images', () => {
  const {html} = renderMarkdown('[x](javascript:alert(1)) ![logo](./img/logo.png) ![bad](http://insecure.test/a.png)', docs.find(d => d.slug === 'cli'));
  assert.match(html, /href="#"/); assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /src="https:\/\/raw\.githubusercontent\.com\/fahamutech\/bfast-tools\/HEAD\/img\/logo\.png"/);
  assert.doesNotMatch(html, /insecure\.test/);
});
