// Public website: landing page at / and documentation at /docs pulled from the
// public GitHub READMEs of the BFast repositories.
import {readFileSync} from 'node:fs';
import {Marked} from 'marked';

const read = file => readFileSync(new URL(`./site/${file}`, import.meta.url), 'utf8');
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const slugify = text => text.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'section';

// Documentation sources. `repo` docs are fetched from GitHub; `local` docs ship with this repository.
export const docs = [
  {slug: 'getting-started', group: 'Start here', title: 'Getting started', local: 'content/getting-started.md'},
  {slug: 'functions', group: 'Runtime · bfast-functions', title: 'Overview', repo: 'fahamutech/bfast-functions', path: 'README.md'},
  {slug: 'function-spec', group: 'Runtime · bfast-functions', title: 'Function specification', repo: 'fahamutech/bfast-functions', path: 'docs/function-spec.md'},
  {slug: 'endpoints', group: 'Runtime · bfast-functions', title: 'Static assets & endpoints', repo: 'fahamutech/bfast-functions', path: 'docs/static-assets-and-endpoints.md'},
  {slug: 'runtime-options', group: 'Runtime · bfast-functions', title: 'Runtime options', repo: 'fahamutech/bfast-functions', path: 'docs/runtime-options.md'},
  {slug: 'environment-variables', group: 'Runtime · bfast-functions', title: 'Environment variables', repo: 'fahamutech/bfast-functions', path: 'docs/environment-variables.md'},
  {slug: 'docker', group: 'Runtime · bfast-functions', title: 'Docker', repo: 'fahamutech/bfast-functions', path: 'docs/docker.md'},
  {slug: 'security-and-ops', group: 'Runtime · bfast-functions', title: 'Security & operations', repo: 'fahamutech/bfast-functions', path: 'docs/security-and-ops.md'},
  {slug: 'cli', group: 'CLI · bfast-tools', title: 'Overview', repo: 'fahamutech/bfast-tools', path: 'README.md'},
  {slug: 'cli-commands', group: 'CLI · bfast-tools', title: 'Functions commands', repo: 'fahamutech/bfast-tools', path: 'docs/commands/functions.md'},
  {slug: 'workspace-format', group: 'CLI · bfast-tools', title: 'Workspace format', repo: 'fahamutech/bfast-tools', path: 'docs/workspace-format.md'},
  {slug: 'cli-configuration', group: 'CLI · bfast-tools', title: 'Configuration', repo: 'fahamutech/bfast-tools', path: 'docs/configuration.md'},
  {slug: 'troubleshooting', group: 'CLI · bfast-tools', title: 'Troubleshooting', repo: 'fahamutech/bfast-tools', path: 'docs/troubleshooting.md'},
  {slug: 'cloud', group: 'Cloud · console & deploys', title: 'Console, webhooks & access', repo: 'fahamutech/bfast-webhook', path: 'README.md'}
];
const bySource = new Map(docs.filter(d => d.repo).map(d => [`${d.repo}/${d.path}`, d]));

const resolvePath = (base, target) => {
  const parts = base.split('/').slice(0, -1);
  for (const piece of target.split('/')) { if (piece === '..') parts.pop(); else if (piece && piece !== '.') parts.push(piece); }
  return parts.join('/');
};

export function renderMarkdown(markdown, doc) {
  const headings = [], used = new Map();
  const link = href => {
    if (!href || /^(https?:|mailto:)/i.test(href)) return href;
    if (href.startsWith('#')) return href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return '#';
    if (!doc.repo) return href;
    const [target, hash = ''] = href.split('#');
    const resolved = resolvePath(doc.path, target);
    const known = bySource.get(`${doc.repo}/${resolved}`);
    return known ? `/docs/${known.slug}${hash ? '#' + hash : ''}` : `https://github.com/${doc.repo}/blob/HEAD/${resolved}${hash ? '#' + hash : ''}`;
  };
  const marked = new Marked({gfm: true, renderer: {
    // Repository markdown is rendered as text only: raw HTML is escaped.
    html({text}) { return escapeHtml(text); },
    heading({tokens, depth}) {
      const html = this.parser.parseInline(tokens), plain = html.replace(/<[^>]+>/g, '');
      let id = slugify(plain); const n = used.get(id) || 0; used.set(id, n + 1); if (n) id += `-${n}`;
      if (depth === 2 || depth === 3) headings.push({id, depth, text: plain});
      return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${depth}>\n`;
    },
    link({href, title, tokens}) {
      const target = link(href), external = /^https?:/i.test(target || '');
      return `<a href="${escapeHtml(target || '#')}"${title ? ` title="${escapeHtml(title)}"` : ''}${external ? ' target="_blank" rel="noopener"' : ''}>${this.parser.parseInline(tokens)}</a>`;
    },
    image({href, title, text}) {
      let src = href || '';
      if (doc.repo && src && !/^https?:/i.test(src)) src = `https://raw.githubusercontent.com/${doc.repo}/HEAD/${resolvePath(doc.path, src)}`;
      if (!/^https:/i.test(src)) return escapeHtml(text || '');
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text || '')}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
    },
    code({text, lang}) {
      const language = (lang || '').split(/\s/)[0].replace(/[^\w-]/g, '');
      return `<div class="code"><div class="code-bar"><span>${escapeHtml(language || 'text')}</span><button type="button" class="copy" data-copy>Copy</button></div><pre><code${language ? ` class="language-${language}"` : ''}>${escapeHtml(text)}</code></pre></div>\n`;
    }
  }});
  const html = marked.parse(markdown);
  return {html, headings};
}

export function createSite({fetchText = url => fetch(url, {signal: AbortSignal.timeout(5000)}).then(r => r.ok ? r.text() : Promise.reject(Object.assign(new Error('fetch failed'), {status: r.status}))),
  now = () => Date.now(), ttl = 15 * 60 * 1000, registerUrl = '', contactEmail = 'mama27j@gmail.com', consoleUrl = '/admin'} = {}) {
  const cache = new Map();
  // Early access is requested by email; an administrator creates the service and grants access.
  const signup = registerUrl || `mailto:${contactEmail}?subject=${encodeURIComponent('BFast Cloud early access request')}&body=${encodeURIComponent('Name:\nGitHub repository:\nGoogle account to sign in with:\nWhat will you run on BFast Cloud?\n')}`;
  const headers = {'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://raw.githubusercontent.com https://github.com https://*.githubusercontent.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
  const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
  const common = {REGISTER_URL: escapeHtml(signup), CONSOLE_URL: escapeHtml(consoleUrl), CONTACT_EMAIL: escapeHtml(contactEmail), YEAR: String(new Date(now()).getFullYear())};
  const assets = {'site.css': 'text/css', 'site.js': 'text/javascript', 'js.js': 'text/javascript', 'docs.js': 'text/javascript', 'favicon.svg': 'image/svg+xml'};

  async function load(doc) {
    if (doc.local) return {markdown: read(doc.local), fetchedAt: null, stale: false};
    const key = doc.slug, hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return {markdown: hit.markdown, fetchedAt: hit.at, stale: false};
    try {
      const markdown = await fetchText(`https://raw.githubusercontent.com/${doc.repo}/HEAD/${doc.path}`);
      if (typeof markdown !== 'string' || markdown.length > 1_000_000) throw new Error('invalid document');
      cache.set(key, {markdown, at: now()});
      return {markdown, fetchedAt: now(), stale: false};
    } catch {
      if (hit) return {markdown: hit.markdown, fetchedAt: hit.at, stale: true};
      return {markdown: `# ${doc.title}\n\nThis page could not be loaded from GitHub right now. Read it directly on [GitHub](https://github.com/${doc.repo}/blob/HEAD/${doc.path}).`, fetchedAt: null, stale: true};
    }
  }
  const nav = active => {
    const groups = new Map();
    for (const d of docs) groups.set(d.group, [...(groups.get(d.group) || []), d]);
    return [...groups].map(([group, items]) => `<div class="nav-group"><p>${escapeHtml(group)}</p>${items.map(d => `<a href="/docs/${d.slug}"${d.slug === active ? ' aria-current="page"' : ''}>${escapeHtml(d.title)}</a>`).join('')}</div>`).join('');
  };
  const send = (res, status, type, body, cacheControl) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.setHeader('Cache-Control', cacheControl);
    res.status(status).type(type).send(body);
  };
  return {
    home: async (_, res) => send(res, 200, 'html', fill(read('index.html'), common), 'public, max-age=300'),
    asset: async (req, res) => {
      const file = req.params.file;
      if (!Object.hasOwn(assets, file)) return send(res, 404, 'text', 'Not found', 'no-store');
      send(res, 200, assets[file], read(file), 'public, max-age=3600');
    },
    docs: async (req, res) => {
      const slug = req.params.doc || docs[0].slug, doc = docs.find(d => d.slug === slug);
      if (!doc) return send(res, 404, 'html', fill(read('docs.html'), {...common, TITLE: 'Not found', NAV: nav(''), CONTENT: '<h1>Page not found</h1><p>Choose a page from the menu.</p>', TOC: '', SOURCE: '', PREV: '', NEXT: '', DESCRIPTION: 'BFast Cloud documentation'}), 'no-store');
      const {markdown, fetchedAt, stale} = await load(doc);
      const {html, headings} = renderMarkdown(markdown, doc);
      const index = docs.indexOf(doc), prev = docs[index - 1], next = docs[index + 1];
      const pager = (d, label, cls) => d ? `<a class="${cls}" href="/docs/${d.slug}"><span>${label}</span>${escapeHtml(d.title)}</a>` : '<span></span>';
      const source = doc.repo ? `<a href="https://github.com/${doc.repo}/blob/HEAD/${doc.path}" target="_blank" rel="noopener">View source on GitHub ↗</a>${fetchedAt ? ` · synced ${new Date(fetchedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}${stale ? ' · showing cached copy' : ''}` : 'Maintained with BFast Cloud';
      send(res, 200, 'html', fill(read('docs.html'), {...common, TITLE: escapeHtml(`${doc.title} · ${doc.group}`), DESCRIPTION: escapeHtml(`${doc.title} — BFast Cloud documentation`), NAV: nav(doc.slug), CONTENT: html,
        TOC: headings.map(h => `<a href="#${h.id}" class="toc-${h.depth}">${escapeHtml(h.text)}</a>`).join(''), SOURCE: source,
        PREV: pager(prev, '← Previous', 'prev'), NEXT: pager(next, 'Next →', 'next')}), stale ? 'no-store' : 'public, max-age=300');
    }
  };
}

export function configuredSite(env = process.env) {
  return createSite({registerUrl: env.SITE_REGISTER_URL || '', contactEmail: env.SITE_CONTACT_EMAIL || 'mama27j@gmail.com'});
}
