const $ = id => document.getElementById(id);
const state = {csrf: null, user: null, defaults: {}, services: [], selected: null, view: null, firebase: null, logsTimer: null};
const FIREBASE_VERSION = '11.10.0';

function message(text, error = false) { $('message').replaceChildren(text ? mk('span', {textContent: text}) : ''); $('message').classList.toggle('error', error); if (error) window.scrollTo({top: 0, behavior: 'smooth'}); }
function mk(tag, props = {}, ...kids) { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k !== null && k !== undefined)); return e; }
const badge = (text, kind = text) => mk('span', {className: `badge ${String(kind).toLowerCase()}`, textContent: text});
const when = value => value ? new Date(value).toLocaleString() : '—';
async function run(action) { try { await action(); } catch (e) { message(e.message, true); } }

async function api(path, body, method) {
  method ||= body === undefined ? 'GET' : 'POST';
  const res = await fetch('/admin/api' + path, {method, credentials: 'same-origin', cache: 'no-store',
    headers: method === 'GET' ? {} : {'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf || ''}, body: body === undefined ? undefined : JSON.stringify(body)});
  let data; try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) { if (res.status === 401 && path !== '/login') signedOut(); throw new Error(data.error || `Request failed (${res.status})`); }
  return data;
}

function signedOut() {
  state.csrf = null; state.user = null; state.selected = null; stopLogs();
  $('workspace').hidden = true; $('who').hidden = true; $('login').hidden = false; $('content').replaceChildren(mk('p', {className: 'muted empty', textContent: 'Select a service to manage it.'}));
}
function signedIn(data) {
  state.csrf = data.csrf; state.user = data.user; state.defaults = data.defaults || state.defaults;
  $('login').hidden = true; $('workspace').hidden = false; $('who').hidden = false;
  $('who-text').textContent = `${data.user.email} · ${data.user.role}`;
  $('avatar').hidden = !data.user.picture; if (data.user.picture) $('avatar').src = data.user.picture;
  $('admin-nav').hidden = data.user.role !== 'admin';
}

async function firebaseAuth() {
  if (state.firebase) return state.firebase;
  const config = (await api('/config')).firebase;
  const [{initializeApp}, auth] = await Promise.all([import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`), import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`)]);
  const app = initializeApp(config);
  state.firebase = {auth: auth.getAuth(app), provider: new auth.GoogleAuthProvider(), signInWithPopup: auth.signInWithPopup, signOut: auth.signOut};
  state.firebase.provider.setCustomParameters({prompt: 'select_account'});
  return state.firebase;
}
$('google').onclick = () => run(async () => {
  $('google').disabled = true;
  try {
    const fb = await firebaseAuth();
    const credential = await fb.signInWithPopup(fb.auth, fb.provider);
    const idToken = await credential.user.getIdToken(true);
    const data = await api('/login', {idToken});
    await fb.signOut(fb.auth).catch(() => {});
    signedIn(data); message(`Signed in as ${data.user.email}.`); await loadServices();
  } catch (e) {
    if (/popup-closed|cancelled-popup/.test(e.code || '')) return;
    if (/unauthorized-domain/.test(e.code || '')) throw new Error('This domain is not authorised in Firebase Authentication. Add it under Authentication → Settings → Authorized domains.');
    throw e;
  } finally { $('google').disabled = false; }
});
$('logout').onclick = () => run(async () => { await api('/logout', {}); signedOut(); message('Signed out.'); });
$('refresh').onclick = () => run(loadServices);
$('filter').oninput = renderServices;
for (const b of $('admin-nav').querySelectorAll('button')) b.onclick = () => run(() => openView(b.dataset.view));

async function loadServices() {
  state.services = await api('/services'); renderServices();
  if (state.selected && !state.services.some(s => s.id === state.selected.id)) { state.selected = null; openView(null); }
}
function renderServices() {
  const filter = $('filter').value.trim().toLowerCase(), list = $('services'); list.replaceChildren();
  const visible = state.services.filter(s => !filter || s.name.toLowerCase().includes(filter) || (s.project || '').includes(filter));
  if (!visible.length) list.append(mk('p', {className: 'muted', textContent: state.services.length ? 'No matches.' : 'No services assigned to you yet.'}));
  for (const s of visible) {
    const b = mk('button', {className: 'service' + (state.selected?.id === s.id ? ' active' : ''), onclick: () => run(() => openService(s.id))},
      mk('span', {className: `dot ${s.kind === 'control' ? 'control' : s.status}`}),
      mk('span', {textContent: s.name}, mk('small', {textContent: s.kind === 'control' ? 'management service' : s.replicas === 0 ? 'archived · 0 replicas' : `${s.running}/${s.replicas} running · ${s.status}`})));
    list.append(b);
  }
}
function showDetail(open) { $('workspace').classList.toggle('detail-open', open); if (open && matchMedia('(max-width: 900px)').matches) window.scrollTo({top: 0}); }
$('back').onclick = () => { stopLogs(); state.selected = null; state.view = null; showDetail(false); setActive(); };
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = mk('textarea', {value: text}); document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
  message(`${label} copied.`);
}
function setActive() { for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === state.view); renderServices(); }

async function openView(view) {
  stopLogs(); state.view = view; state.selected = null; setActive(); showDetail(Boolean(view));
  const content = $('content'); content.replaceChildren();
  if (view === 'swarm') return renderSwarm(content);
  if (view === 'users') return renderUsers(content);
  if (view === 'create') return renderCreate(content);
  content.append(mk('p', {className: 'muted empty', textContent: 'Select a service to manage it.'}));
}

// ---------- Service view ----------
async function openService(id, tab = 'overview') {
  stopLogs();
  const s = await api('/services/' + encodeURIComponent(id));
  state.selected = s; state.view = null; setActive(); showDetail(true);
  const content = $('content'); content.replaceChildren($('service-view').content.cloneNode(true));
  content.querySelector('.title').textContent = s.name;
  content.querySelector('.subtitle').textContent = `${s.image} · ${s.kind === 'control' ? 'management service' : s.project ? 'project ' + s.project : 'application'}`;
  const actions = content.querySelector('.actions');
  const act = (label, action, cls = 'secondary', confirmText) => mk('button', {type: 'button', className: cls, textContent: label, onclick: () => run(async () => {
    if (confirmText && !confirm(confirmText)) return;
    const r = await api(`/services/${encodeURIComponent(s.id)}/actions`, {action}); message(r.message + (r.warnings?.length ? ' ' + r.warnings.join(' ') : ''));
    await loadServices(); setTimeout(() => run(() => openService(s.id, currentTab())), 1500);
  })});
  if (s.kind === 'control') actions.append(act('Restart', 'restart', 'secondary', 'Restart the management service? You stay signed in.'));
  else {
    if (s.replicas === 0) actions.append(act('▶ Unarchive', 'unarchive', '', `Unarchive ${s.name}? It starts with 1 replica.`));
    else { actions.append(act('Restart', 'restart', 'secondary', `Restart ${s.name}? Tasks are replaced one by one.`)); actions.append(act('■ Archive', 'archive', 'danger', `Archive ${s.name}? This scales it to 0 replicas; configuration and secrets are kept.`)); }
  }
  const tabs = content.querySelector('.tabs');
  for (const b of tabs.querySelectorAll('button')) {
    if (b.dataset.tab === 'secrets' && s.kind === 'control') b.hidden = true;
    b.onclick = () => showTab(b.dataset.tab);
  }
  function currentTab() { return tabs.querySelector('[aria-selected=true]')?.dataset.tab || 'overview'; }
  function showTab(name) {
    for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', b.dataset.tab === name);
    for (const p of content.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== name;
    if (name !== 'logs') stopLogs();
    if (name === 'deploy') run(() => deploy.load());
    const active = tabs.querySelector(`[data-tab="${name}"]`); tabs.scrollTo({left: active.offsetLeft - 16, behavior: 'smooth'});
  }
  renderOverview(content.querySelector('[data-panel=overview]'), s);
  renderEnv(content.querySelector('[data-panel=env]'), s);
  if (s.kind !== 'control') await renderSecrets(content.querySelector('[data-panel=secrets]'), s);
  renderSettings(content.querySelector('[data-panel=settings]'), s);
  renderLogs(content.querySelector('[data-panel=logs]'), s);
  const deploy = renderDeploy(content.querySelector('[data-panel=deploy]'), s);
  showTab(tab);
}

function renderOverview(panel, s) {
  const stats = mk('div', {className: 'stats'},
    mk('div', {className: 'stat'}, mk('b', {}, badge(s.kind === 'control' ? 'control' : s.status)), mk('span', {textContent: 'Status'})),
    mk('div', {className: 'stat'}, mk('b', {textContent: `${s.running} / ${s.replicas}`}), mk('span', {textContent: 'Running / desired replicas'})),
    mk('div', {className: 'stat'}, mk('b', {}, badge({on: 'auto-deploy on', paused: 'paused', off: 'off'}[s.autoDeploy] || 'off', s.autoDeploy === 'on' ? 'running' : s.autoDeploy === 'paused' ? 'degraded' : 'archived')), mk('span', {textContent: 'GitHub auto-deploy'})),
    mk('div', {className: 'stat'}, mk('b', {textContent: s.cpus ? s.cpus + ' CPU' : 'unlimited'}), mk('span', {textContent: 'CPU limit'})),
    mk('div', {className: 'stat'}, mk('b', {textContent: s.memoryMB ? s.memoryMB + ' MB' : 'unlimited'}), mk('span', {textContent: 'Memory limit'})),
    mk('div', {className: 'stat'}, mk('b', {textContent: when(s.updatedAt)}), mk('span', {textContent: 'Last updated'})));
  panel.append(stats);
  const facts = mk('table', {}, mk('tbody', {}, ...[['Image', s.image], ['Mode', s.modeEnv || '—'], ['Git clone URL', s.gitCloneUrl || '—'], ['Restart policy', s.restart], ['Networks', s.networks.join(', ') || '—'],
    ['Hostnames', s.hosts.length ? mk('div', {className: 'hosts'}, ...s.hosts.map(h => mk('a', {href: 'https://' + h, target: '_blank', rel: 'noopener', textContent: h}))) : '—'],
    ...(s.users ? [['Assigned users', s.users.join(', ') || 'none (administrators only)']] : [])].map(([k, v]) => mk('tr', {}, mk('th', {textContent: k}), mk('td', {}, typeof v === 'string' ? document.createTextNode(v) : v)))));
  panel.append(mk('h3', {textContent: 'Details'}), facts, mk('h3', {textContent: 'Recent tasks'}));
  if (!s.tasks.length) return panel.append(mk('p', {className: 'muted', textContent: 'No tasks yet.'}));
  panel.append(mk('table', {}, mk('thead', {}, mk('tr', {}, ...['Slot', 'State', 'Desired', 'Node', 'Message', 'Updated'].map(t => mk('th', {textContent: t})))),
    mk('tbody', {}, ...s.tasks.map(t => mk('tr', {}, mk('td', {textContent: t.slot ?? '—'}), mk('td', {}, badge(t.state)), mk('td', {textContent: t.desired || '—'}), mk('td', {textContent: t.node || '—'}),
      mk('td', {textContent: [t.message, t.error, t.exitCode !== null && t.exitCode !== undefined ? `exit ${t.exitCode}` : ''].filter(Boolean).join(' · ')}), mk('td', {textContent: when(t.updatedAt)}))))));
}

function renderSettings(panel, s) {
  const form = mk('form', {className: 'settings-form'});
  const field = (title, props) => { const input = mk('input', props); form.append(mk('label', {textContent: title}, input)); return input; };
  let image = null;
  if (s.canEditImage) image = field('Image', {value: s.image, required: true, maxLength: 255, spellcheck: false, autocomplete: 'off'});
  const grid = mk('div', {className: 'settings'}); form.append(grid);
  const g = (title, props) => { const input = mk('input', props); grid.append(mk('label', {textContent: title}, input)); return input; };
  const replicas = g('Replicas (0 = archived)', {type: 'number', min: s.kind === 'control' ? 1 : 0, max: 100, step: 1, value: s.replicas, required: true});
  const cpus = g('CPU limit (0 = unlimited)', {type: 'number', min: 0, max: 128, step: 0.001, value: s.cpus, required: true});
  const memory = g('Memory MB (0 = unlimited)', {type: 'number', min: 0, max: 1048576, step: 'any', value: s.memoryMB, required: true});
  const restart = mk('select', {}, ...[['any', 'Always'], ['on-failure', 'On failure'], ['none', 'Never']].map(([v, t]) => mk('option', {value: v, textContent: t}))); restart.value = s.restart;
  grid.append(mk('label', {textContent: 'Restart policy'}, restart));
  form.append(mk('p', {className: 'muted', textContent: s.kind === 'control' ? 'Changes restart the management service. Keep at least one replica.' : 'Saving redeploys the service with the current environment and secrets. Zero replicas archives it.'}),
    mk('button', {type: 'submit', textContent: 'Save & redeploy'}));
  if (s.constraints.length || Object.keys(s.labels).length) form.append(mk('details', {}, mk('summary', {textContent: 'Labels and constraints (read-only)'}),
    mk('table', {}, mk('tbody', {}, ...s.constraints.map(c => mk('tr', {}, mk('th', {textContent: 'constraint'}), mk('td', {textContent: c}))), ...Object.entries(s.labels).map(([k, v]) => mk('tr', {}, mk('th', {textContent: k}), mk('td', {textContent: v})))))));
  form.onsubmit = e => { e.preventDefault(); run(async () => {
    if (!confirm(`Save settings and redeploy ${s.name}?`)) return;
    const body = {version: s.version, env: s.env, replicas: Number(replicas.value), cpus: Number(cpus.value), memoryMB: Number(memory.value), restart: restart.value};
    if (image && image.value !== s.image) body.image = image.value;
    const r = await api('/services/' + encodeURIComponent(s.id), body); message(r.message + (r.warnings.length ? ' ' + r.warnings.join(' ') : ''));
    await loadServices(); if (s.kind !== 'control') await openService(s.id, 'settings');
  }); };
  panel.append(form);
}

// ---------- Auto-deploy (GitHub webhook) ----------
function renderDeploy(panel, s) {
  let loaded = null;
  const field = (label, value, {secret = false, copyLabel = label} = {}) => {
    const out = mk('code', {className: 'value', textContent: secret ? '•'.repeat(24) : value});
    const tools = mk('div', {className: 'field-tools'});
    if (secret) { let shown = false; tools.append(mk('button', {type: 'button', className: 'secondary small', textContent: 'Reveal', onclick: e => { shown = !shown; out.textContent = shown ? value : '•'.repeat(24); e.target.textContent = shown ? 'Hide' : 'Reveal'; }})); }
    tools.append(mk('button', {type: 'button', className: 'secondary small', textContent: 'Copy', onclick: () => run(() => copy(value, copyLabel))}));
    return mk('div', {className: 'field'}, mk('span', {className: 'field-label', textContent: label}), mk('div', {className: 'field-row'}, out, tools));
  };
  async function act(action, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    const r = await api(`/services/${encodeURIComponent(s.id)}/webhook`, {action, version: loaded.version});
    message(r.message); s.version = r.version; draw(r); loadServices();
  }
  function draw(w) {
    loaded = w; panel.replaceChildren();
    const status = !w.ready ? badge('not ready', 'error') : w.paused ? badge('paused', 'degraded') : badge('active', 'running');
    panel.append(mk('div', {className: 'toolbar'}, mk('p', {className: 'lead'}, status, document.createTextNode(w.ready ? (w.paused ? ' Pushes are recorded but do not redeploy.' : ` Pushes to the default branch of ${w.repository} restart this service.`) : ' Fix the items below to enable auto-deploy.')),
      mk('button', {type: 'button', className: 'secondary small', textContent: '↻ Refresh', onclick: () => run(load)})));
    if (w.problems.length) panel.append(mk('ul', {className: 'problems'}, ...w.problems.map(p => mk('li', {textContent: p}))));
    const card = mk('div', {className: 'card inset'}, mk('h3', {textContent: 'GitHub webhook settings'}),
      mk('p', {className: 'muted', textContent: 'In the repository, open Settings → Webhooks → Add webhook (or edit the existing one) and use these values.'}),
      field('Payload URL', w.url), field('Content type', w.contentType));
    if (w.secret) card.append(field('Secret', w.secret, {secret: true}));
    card.append(mk('div', {className: 'field'}, mk('span', {className: 'field-label', textContent: 'Events'}), mk('span', {textContent: 'Just the push event'})));
    if (w.settingsUrl) card.append(mk('a', {className: 'button-link', href: w.settingsUrl, target: '_blank', rel: 'noopener', textContent: 'Open repository webhooks ↗'}));
    if (w.sharedSecretAccepted) card.append(mk('p', {className: 'muted', textContent: 'Older hooks that use the shared webhook secret keep working. Switch them to this service secret when convenient.'}));
    panel.append(card);
    const buttons = mk('div', {className: 'actions'});
    buttons.append(w.paused ? mk('button', {type: 'button', textContent: '▶ Resume auto-deploy', onclick: () => run(() => act('resume'))})
      : mk('button', {type: 'button', className: 'secondary', textContent: '⏸ Pause auto-deploy', disabled: !w.ready, onclick: () => run(() => act('pause', `Pause auto-deploy for ${s.name}? Pushes will no longer restart it.`))}));
    if (w.secret) buttons.append(mk('button', {type: 'button', className: 'danger', textContent: 'Rotate secret', onclick: () => run(() => act('rotate', 'Rotate the webhook secret? The current secret stops working immediately, so update GitHub right after.'))}));
    if (s.replicas > 0) buttons.append(mk('button', {type: 'button', className: 'secondary', textContent: 'Deploy now', onclick: () => run(async () => {
      if (!confirm(`Redeploy ${s.name} now? Git services fetch the latest default branch on start.`)) return;
      const r = await api(`/services/${encodeURIComponent(s.id)}/actions`, {action: 'restart'}); message(r.message); await loadServices();
    })}));
    panel.append(buttons);
    panel.append(mk('h3', {textContent: 'Recent deliveries'}), mk('p', {className: 'muted', textContent: `Kept in memory for the last 20 deliveries since the management service started.${w.signatureFailures.count ? ` ${w.signatureFailures.count} request(s) failed the signature check, last at ${when(w.signatureFailures.last)}. Check the secret in GitHub.` : ''}`}));
    if (!w.deliveries.length) return panel.append(mk('p', {className: 'muted empty-small', textContent: 'No deliveries yet. GitHub sends a ping when the webhook is saved; use “Redeliver” in GitHub to test.'}));
    const kind = {deployed: 'running', ping: 'ready', paused: 'degraded', ignored: 'archived', rejected: 'error', failed: 'error'};
    panel.append(mk('ul', {className: 'deliveries'}, ...w.deliveries.map(d => mk('li', {className: 'delivery'},
      mk('div', {className: 'delivery-head'}, badge(d.result, kind[d.result] || d.result), mk('span', {className: 'muted', textContent: when(d.at)}), d.branch ? mk('span', {className: 'chip', textContent: d.branch}) : null),
      d.commit ? mk('div', {className: 'commit'}, d.commit.url ? mk('a', {href: d.commit.url, target: '_blank', rel: 'noopener', textContent: d.commit.id.slice(0, 7)}) : mk('code', {textContent: d.commit.id.slice(0, 7)}), document.createTextNode(' ' + d.commit.message)) : null,
      mk('div', {className: 'muted', textContent: [d.reason, d.pusher || d.commit?.author ? `by ${d.pusher || d.commit.author}` : '', d.secret === 'shared' ? 'shared secret' : ''].filter(Boolean).join(' · ')})))));
  }
  async function load() { panel.replaceChildren(mk('p', {className: 'muted', textContent: 'Loading…'})); draw(await api(`/services/${encodeURIComponent(s.id)}/webhook`)); }
  return {load};
}

// ---------- Environment editor ----------
const ENV_MAX = 131000, B64_HINT = /(b64|base64)/i, B64_LIKELY = /(cert|pem|key|keystore|credential|secret|json)/i;
const utf8 = new TextDecoder('utf-8', {fatal: true});
const cleanB64 = v => v.replace(/\s+/g, '');
const validB64 = v => { const c = cleanB64(v); return c.length > 0 && c.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(c); };
const toB64 = bytes => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const fromB64 = v => Uint8Array.from(atob(cleanB64(v)), c => c.charCodeAt(0));
function decodedText(bytes) { try { const t = utf8.decode(bytes); return /[\x00-\x08\x0e-\x1f]/.test(t) ? null : t; } catch { return null; } }
const size = n => n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
function guessKind(key, value) {
  if (!value) return B64_HINT.test(key) ? 'base64' : 'text';
  if (!validB64(value) || cleanB64(value).length < 16) return 'text';
  if (B64_HINT.test(key) || B64_LIKELY.test(key)) return 'base64';
  try { return decodedText(fromB64(value)) !== null && !/^[0-9]+$/.test(value) && !/\s/.test(value.trim()) ? 'base64' : 'text'; } catch { return 'text'; }
}
function envRow(container, entry = '=') {
  const i = entry.indexOf('='), wrapper = mk('div', {className: 'env-row'});
  const key = mk('input', {value: entry.slice(0, i), placeholder: 'VARIABLE_NAME', required: true, pattern: '[A-Za-z_][A-Za-z0-9_]*', spellcheck: false}); key.setAttribute('aria-label', 'Variable name');
  const value = mk('textarea', {value: entry.slice(i + 1), hidden: true, autocomplete: 'off', spellcheck: false}); value.setAttribute('aria-label', 'Variable value');
  const masked = mk('input', {type: 'password', value: 'hidden-value', readOnly: true}); masked.setAttribute('aria-label', 'Hidden variable value');
  const type = mk('select', {}, ...[['text', 'Text'], ['file', 'File'], ['base64', 'Base64']].map(([v, t]) => mk('option', {value: v, textContent: t}))); type.setAttribute('aria-label', 'Value type');
  type.value = guessKind(key.value, value.value);
  let typeTouched = type.value !== 'text', fileName = '';
  const picker = mk('input', {type: 'file', hidden: true});
  const status = mk('small', {className: 'muted env-status'});
  const upload = mk('button', {type: 'button', className: 'secondary', onclick: () => picker.click()});
  const view = mk('button', {type: 'button', className: 'secondary', textContent: 'View decoded'});
  const download = mk('button', {type: 'button', className: 'secondary', textContent: 'Download'});
  const reveal = mk('button', {type: 'button', className: 'secondary', textContent: 'Reveal'});
  const remove = mk('button', {type: 'button', className: 'secondary', textContent: 'Remove', onclick: () => wrapper.remove()});
  const preview = mk('pre', {className: 'env-preview', hidden: true});
  const holder = mk('div', {}, masked, value, mk('div', {className: 'env-tools'}, upload, view, download, status), picker, preview);
  function refresh() {
    const k = type.value;
    upload.textContent = k === 'base64' ? 'Upload file → Base64' : k === 'file' ? (fileName ? 'Replace file' : 'Choose file') : 'Load from file';
    view.hidden = download.hidden = k !== 'base64';
    value.placeholder = k === 'base64' ? 'Paste Base64 here, or upload a file to convert it' : k === 'file' ? 'File contents appear here after choosing a file' : 'Value';
    let text = '';
    if (k === 'base64' && value.value) text = validB64(value.value) ? size(Math.floor(cleanB64(value.value).length * 3 / 4)) + ' decoded' : '⚠ Not valid Base64';
    else if (k === 'file' && fileName) text = fileName + ' · ' + size(value.value.length);
    else if (value.value) text = size(value.value.length);
    status.textContent = text; status.classList.toggle('error', text.startsWith('⚠'));
    if (!preview.hidden) showPreview();
  }
  function decoded() { if (!validB64(value.value)) throw new Error('Value is not valid Base64.'); return fromB64(value.value); }
  function showPreview() {
    try { const bytes = decoded(), t = decodedText(bytes); preview.textContent = t ?? `Binary data · ${size(bytes.length)}\n${[...bytes.subarray(0, 64)].map(b => b.toString(16).padStart(2, '0')).join(' ')}${bytes.length > 64 ? ' …' : ''}`; }
    catch (e) { preview.textContent = e.message; }
  }
  view.onclick = () => { preview.hidden = !preview.hidden; view.textContent = preview.hidden ? 'View decoded' : 'Hide decoded'; if (!preview.hidden) showPreview(); };
  download.onclick = () => run(async () => { const bytes = decoded(), a = mk('a', {href: URL.createObjectURL(new Blob([bytes])), download: (key.value || 'value') + '.bin'}); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); });
  reveal.onclick = () => { value.hidden = !value.hidden; masked.hidden = !value.hidden; reveal.textContent = value.hidden ? 'Reveal' : 'Hide'; };
  picker.onchange = () => run(async () => {
    const f = picker.files[0]; picker.value = ''; if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer()); let text = null;
    if (type.value !== 'base64') { text = decodedText(bytes); if (text === null) { type.value = 'base64'; typeTouched = true; message(`${f.name} is binary, so it was converted to Base64.`); } }
    const next = type.value === 'base64' ? toB64(bytes) : text;
    if (next.length > ENV_MAX) return message(`${f.name} is too large for an environment variable (limit ${size(ENV_MAX)} after encoding).`, true);
    value.value = next; fileName = f.name; if (type.value === 'text') { type.value = 'file'; typeTouched = true; }
    value.hidden = false; masked.hidden = true; reveal.textContent = 'Hide'; refresh();
  });
  type.onchange = () => {
    typeTouched = true; const v = value.value;
    if (type.value === 'base64' && v && !validB64(v)) { try { value.value = toB64(new TextEncoder().encode(v)); } catch {} }
    else if (type.value !== 'base64' && v && validB64(v) && guessKind(key.value, v) === 'base64') { try { const t = decodedText(fromB64(v)); if (t !== null) value.value = t; } catch {} }
    refresh();
  };
  key.oninput = () => { if (!typeTouched && !value.value && B64_HINT.test(key.value)) { type.value = 'base64'; refresh(); } };
  value.oninput = () => { if (!typeTouched && type.value === 'text' && guessKind(key.value, value.value) === 'base64') type.value = 'base64'; refresh(); };
  value.onpaste = () => setTimeout(() => { if (type.value === 'base64' && validB64(value.value)) value.value = cleanB64(value.value); refresh(); });
  wrapper.append(key, type, holder, reveal, remove);
  wrapper.env = () => {
    let v = value.value;
    if (type.value === 'base64' && v) { if (!validB64(v)) { key.reportValidity(); throw new Error(`${key.value || 'Variable'} is not valid Base64.`); } v = cleanB64(v); }
    if (v.length > ENV_MAX) throw new Error(`${key.value} is too large (limit ${size(ENV_MAX)}).`);
    return key.value + '=' + v;
  };
  refresh(); container.append(wrapper); return wrapper;
}
function renderEnv(panel, s) {
  const envs = panel.querySelector('.envs'); envs.replaceChildren(); s.env.forEach(e => envRow(envs, e));
  if (s.kind === 'control') panel.querySelector('.muted').textContent = 'This is the management service. ADMIN_EMAILS and SERVICE_USERS control who signs in; prefer the Users page for those. Saving restarts the manager.';
  panel.querySelector('.add-env').onclick = () => envRow(envs);
  panel.querySelector('.env-form').onsubmit = e => { e.preventDefault(); run(async () => {
    if (!confirm(`Save environment and redeploy ${s.name}?`)) return;
    const r = await api('/services/' + encodeURIComponent(s.id), {version: s.version, env: [...envs.children].map(r => r.env()), replicas: s.replicas, cpus: s.cpus, memoryMB: s.memoryMB, restart: s.restart});
    message(r.message + (r.warnings.length ? ' ' + r.warnings.join(' ') : '')); await loadServices(); if (s.kind !== 'control') await openService(s.id, 'env');
  }); };
}

// ---------- Secrets ----------
async function renderSecrets(panel, s) {
  let choices = await api('/services/' + encodeURIComponent(s.id) + '/secrets');
  const mounts = mk('div'), choice = mk('select'), attach = mk('button', {type: 'button', className: 'secondary', textContent: 'Attach secret'});
  const name = mk('input', {maxLength: 32, placeholder: 'database-password-v2', autocomplete: 'off'}), value = mk('textarea', {autocomplete: 'off', spellcheck: false, maxLength: 65536});
  const createBtn = mk('button', {type: 'button', className: 'secondary', textContent: 'Create secret'}), save = mk('button', {type: 'button', textContent: 'Save attachments & redeploy'});
  panel.append(mk('p', {className: 'muted', textContent: 'Values are write-only. Create a new version to change a value, then replace its attachment. Attach the secret, then set an environment variable to /run/secrets/<filename>; BFast Functions loads the file contents at startup.'}),
    mounts, mk('div', {className: 'toolbar'}, mk('label', {textContent: 'Available secret'}, choice), attach),
    mk('details', {}, mk('summary', {textContent: 'Create a secret for this service'}), mk('label', {textContent: 'Secret name'}, name), mk('label', {textContent: 'Secret value'}, value),
      mk('p', {className: 'muted', textContent: 'Stored immediately in Swarm. Names are prefixed for this service. The value cannot be read back.'}), createBtn), save);
  function renderChoices() { choice.replaceChildren(...choices.map(c => mk('option', {value: c.id, textContent: c.name}))); attach.disabled = !choices.length; }
  function secretRow(secret) {
    const wrapper = mk('div', {className: 'secret-mount'}, mk('p', {textContent: secret.name || secret.id}));
    const fields = mk('div', {className: 'settings'}); wrapper.append(fields);
    const field = (title, v, pattern) => { const input = mk('input', {value: v, required: true, pattern}); fields.append(mk('label', {textContent: title}, input)); return input; };
    const target = field('Filename under /run/secrets/', secret.target || 'secret', '[A-Za-z0-9](?:[A-Za-z0-9_.]|-){0,127}');
    const uid = field('Owner UID', secret.uid ?? '0', '[0-9]+'), gid = field('Group GID', secret.gid ?? '0', '[0-9]+');
    const mode = mk('select', {}, ...[[256, '0400 · owner'], [288, '0440 · owner + group'], [292, '0444 · everyone']].map(([v, t]) => mk('option', {value: v, textContent: t}))); mode.value = secret.mode ?? 256;
    fields.append(mk('label', {textContent: 'Read permissions'}, mode));
    const path = mk('p', {className: 'muted'}); const updatePath = () => { path.textContent = 'Container path: /run/secrets/' + target.value; }; target.oninput = updatePath; updatePath();
    wrapper.append(path, mk('button', {type: 'button', className: 'secondary', textContent: 'Detach on save', onclick: () => wrapper.remove()}));
    wrapper.secret = () => ({id: secret.id, target: target.value, uid: uid.value, gid: gid.value, mode: Number(mode.value)});
    mounts.append(wrapper);
  }
  renderChoices(); (s.secrets || []).forEach(secretRow);
  attach.onclick = () => { const c = choices.find(c => c.id === choice.value); if (!c) return; if ([...mounts.children].some(r => r.secret().id === c.id)) return message('This secret is already attached.', true); secretRow({...c, target: c.name.replace(/^app-[^-]+-/, '')}); };
  createBtn.onclick = () => run(async () => {
    const v = value.value, n = name.value; value.value = ''; createBtn.disabled = true;
    try { const r = await api('/services/' + encodeURIComponent(s.id) + '/secrets', {name: n, value: v}); choices.push(r); renderChoices(); choice.value = r.id; name.value = ''; message('Secret created. Attach it, set its filename, then save.'); }
    finally { createBtn.disabled = false; }
  });
  save.onclick = () => run(async () => {
    if (!confirm(`Apply secret attachments and redeploy ${s.name}?`)) return;
    const r = await api('/services/' + encodeURIComponent(s.id), {version: s.version, env: s.env, replicas: s.replicas, cpus: s.cpus, memoryMB: s.memoryMB, restart: s.restart, secrets: [...mounts.children].map(r => r.secret())});
    message(r.message + (r.warnings.length ? ' ' + r.warnings.join(' ') : '')); await loadServices(); await openService(s.id, 'secrets');
  });
}

// ---------- Logs ----------
function stopLogs() { if (state.logsTimer) clearInterval(state.logsTimer); state.logsTimer = null; }
function renderLogs(panel, s) {
  const pre = panel.querySelector('.logs'), tail = panel.querySelector('.tail'), follow = panel.querySelector('.follow'), load = panel.querySelector('.load-logs');
  async function fetchLogs() {
    load.disabled = true;
    try { const r = await api(`/services/${encodeURIComponent(s.id)}/logs?tail=${tail.value}`); pre.textContent = r.lines.length ? r.lines.join('\n') : '(no log output)'; pre.scrollTop = pre.scrollHeight; }
    finally { load.disabled = false; }
  }
  load.onclick = () => run(fetchLogs);
  follow.onchange = () => { stopLogs(); if (follow.checked) { run(fetchLogs); state.logsTimer = setInterval(() => run(fetchLogs), 10000); } };
}

// ---------- Admin: Swarm ----------
async function renderSwarm(content) {
  content.append(mk('h2', {textContent: 'Swarm status'}), mk('p', {className: 'muted', textContent: 'Loading…'}));
  const data = await api('/swarm'); content.replaceChildren(mk('div', {className: 'toolbar'}, mk('h2', {textContent: 'Swarm status'}), mk('button', {className: 'secondary small', textContent: '↻ Refresh', onclick: () => run(() => openView('swarm'))})));
  const w = data.swarm;
  content.append(mk('div', {className: 'stats'}, ...[[badge(w.state), 'Swarm state'], [`${w.nodes}`, 'Nodes'], [`${w.managers}`, 'Managers'], [`${data.services.length}`, 'Services'], [`${w.cpus} / ${w.memoryGB} GB`, 'Manager CPUs / memory'], [w.engine, 'Docker engine']]
    .map(([v, l]) => mk('div', {className: 'stat'}, mk('b', {}, typeof v === 'string' ? document.createTextNode(v) : v), mk('span', {textContent: l})))));
  content.append(mk('h3', {textContent: 'Nodes'}), mk('table', {}, mk('thead', {}, mk('tr', {}, ...['Hostname', 'Role', 'State', 'Availability', 'Address', 'Resources', 'Engine'].map(t => mk('th', {textContent: t})))),
    mk('tbody', {}, ...data.nodes.map(n => mk('tr', {}, mk('td', {textContent: n.hostname}), mk('td', {textContent: n.role + (n.leader ? ' · leader' : '') + (n.reachability ? ' · ' + n.reachability : '')}), mk('td', {}, badge(n.state)), mk('td', {}, badge(n.availability)), mk('td', {textContent: n.address}), mk('td', {textContent: `${n.cpus} CPU · ${n.memoryGB} GB`}), mk('td', {textContent: `${n.engine} ${n.os}`}))))));
  content.append(mk('h3', {textContent: 'All services'}), mk('p', {className: 'muted', textContent: 'Infrastructure services (Traefik, BFast API) are read-only here.'}), mk('table', {}, mk('thead', {}, mk('tr', {}, ...['Service', 'Kind', 'Status', 'Running / desired', 'Image', 'Updated'].map(t => mk('th', {textContent: t})))),
    mk('tbody', {}, ...data.services.map(s => mk('tr', {}, mk('td', {}, s.kind === 'protected' ? document.createTextNode(s.name) : mk('a', {href: '#', textContent: s.name, onclick: e => { e.preventDefault(); run(() => openService(s.id)); }})), mk('td', {textContent: s.kind}), mk('td', {}, badge(s.status)), mk('td', {textContent: `${s.running} / ${s.mode === 'global' ? 'global' : s.replicas}`}), mk('td', {textContent: s.image}), mk('td', {textContent: when(s.updatedAt)}))))));
}

// ---------- Admin: Users ----------
async function renderUsers(content) {
  content.append(mk('h2', {textContent: 'Users & access'}), mk('p', {className: 'muted', textContent: 'Loading…'}));
  const data = await api('/users'); content.replaceChildren(mk('h2', {textContent: 'Users & access'}));
  content.append(mk('p', {className: 'muted', textContent: `Administrators (from ADMIN_EMAILS): ${data.admins.join(', ')}. Users below sign in with Google and only see the services assigned to them. Saving stores the list in the SERVICE_USERS environment of the "${data.selfName}" service, which restarts it.`}));
  if (!data.manageable) content.append(mk('p', {className: 'muted', textContent: `⚠ The management service "${data.selfName}" was not found in Swarm. Set SELF_SERVICE_NAME to its name to enable saving.`}));
  const rows = mk('div');
  function userRow(u = {email: '', services: []}) {
    const row = mk('div', {className: 'user-row'});
    const email = mk('input', {type: 'email', value: u.email, placeholder: 'user@gmail.com', required: true}); email.setAttribute('aria-label', 'Google account email');
    const chips = mk('div', {className: 'chips'}); const assigned = new Set(u.services);
    const picker = mk('select', {}, mk('option', {value: '', textContent: '+ add service…'}), ...data.services.map(n => mk('option', {value: n, textContent: n})));
    function renderChips() { chips.replaceChildren(...[...assigned].map(n => mk('span', {className: 'chip', textContent: n}, mk('button', {type: 'button', textContent: '×', title: 'Remove', onclick: () => { assigned.delete(n); renderChips(); }}))), picker); }
    picker.onchange = () => { if (picker.value) assigned.add(picker.value); picker.value = ''; renderChips(); };
    renderChips();
    row.append(email, chips, mk('button', {type: 'button', className: 'danger small', textContent: 'Remove user', onclick: () => row.remove()}));
    row.user = () => ({email: email.value.trim(), services: [...assigned]});
    rows.append(row);
  }
  data.users.forEach(userRow);
  const form = mk('form', {}, rows, mk('div', {className: 'toolbar'}, mk('button', {type: 'button', className: 'secondary', textContent: '+ Add user', onclick: () => userRow()}), mk('button', {type: 'submit', textContent: 'Save users', disabled: !data.manageable})));
  form.onsubmit = e => { e.preventDefault(); run(async () => {
    const users = [...rows.children].map(r => r.user());
    if (!confirm(`Save ${users.length} user(s)? The management service restarts afterwards.`)) return;
    const r = await api('/users', {users, version: data.version}); message(r.message); setTimeout(() => run(() => openView('users')), 1500);
  }); };
  content.append(form);
}

// ---------- Admin: Create ----------
function renderCreate(content) {
  const d = state.defaults || {};
  content.append(mk('h2', {textContent: 'New service'}), mk('p', {className: 'muted', textContent: 'Creates a replicated BFast Functions service on the bfastweb network with Traefik TLS routing, following the create_faas.sh conventions.'}));
  const form = mk('form'); const grid = mk('div', {className: 'settings'});
  const f = (title, props, parent = grid) => { const input = mk('input', props); parent.append(mk('label', {textContent: title}, input)); return input; };
  const project = f('Project ID (service becomes <id>_faas)', {required: true, pattern: '[a-z0-9][a-z0-9-]{1,40}', placeholder: 'demo123', spellcheck: false});
  const image = f('Image', {value: d.image || 'joshuamshana/bfastfunction:latest', required: true, spellcheck: false});
  const mode = mk('select', {}, ...['git', 'npm', 'url'].map(v => mk('option', {value: v, textContent: v}))); grid.append(mk('label', {textContent: 'MODE'}, mode));
  const source = f('GIT_CLONE_URL / NPM_TAR / URL_TAR', {placeholder: 'https://github.com/acme/functions.git', spellcheck: false});
  const gitUser = f('GIT_USERNAME (private repos)', {autocomplete: 'off'}); const gitToken = f('GIT_TOKEN (private repos)', {type: 'password', autocomplete: 'off'});
  const replicas = f('Replicas (0 = create archived)', {type: 'number', min: 0, max: 100, step: 1, value: 1, required: true});
  const cpus = f('CPU limit (0 = unlimited)', {type: 'number', min: 0, max: 128, step: 0.001, value: 0, required: true});
  const memory = f('Memory MB (0 = unlimited)', {type: 'number', min: 0, max: 1048576, step: 'any', value: 0, required: true});
  const restart = mk('select', {}, ...[['any', 'Always'], ['on-failure', 'On failure'], ['none', 'Never']].map(([v, t]) => mk('option', {value: v, textContent: t}))); grid.append(mk('label', {textContent: 'Restart policy'}, restart));
  form.append(grid);
  const hostsHint = mk('p', {className: 'muted'});
  const hosts = f('Extra hostnames (comma separated, optional)', {placeholder: 'api.example.com', spellcheck: false}, form);
  const updateHint = () => { const p = project.value || '<id>'; hostsHint.textContent = d.cluster && d.hostDomain ? `Default hostnames: ${p}-faas.${d.cluster}.${d.hostDomain}, ${p}.api.${d.hostDomain}` : 'SWARM_CLUSTER / SWARM_HOST_DOMAIN are not set on the manager, so at least one hostname is required.'; };
  project.oninput = updateHint; updateHint(); form.insertBefore(hostsHint, hosts.parentElement);
  const sticky = mk('input', {type: 'checkbox', checked: true}); form.append(mk('label', {className: 'inline'}, sticky, document.createTextNode(' Sticky sessions (Traefik cookie)')));
  const users = f('Assign users (comma separated Google emails, optional)', {placeholder: 'dev@gmail.com', spellcheck: false}, form);
  form.append(mk('h3', {textContent: 'Additional environment variables'}), mk('p', {className: 'muted', textContent: 'PROJECT_ID, PORT and PRODUCTION are set automatically.'}));
  const envs = mk('div'); form.append(envs, mk('button', {type: 'button', className: 'secondary', textContent: '+ Add variable', onclick: () => envRow(envs)}), mk('p'), mk('button', {type: 'submit', textContent: 'Create service'}));
  form.onsubmit = e => { e.preventDefault(); run(async () => {
    const env = [...envs.children].map(r => r.env()), key = {git: 'GIT_CLONE_URL', npm: 'NPM_TAR', url: 'URL_TAR'}[mode.value];
    env.push(`MODE=${mode.value}`); if (source.value.trim()) env.push(`${key}=${source.value.trim()}`);
    if (gitUser.value.trim()) env.push(`GIT_USERNAME=${gitUser.value.trim()}`); if (gitToken.value) env.push(`GIT_TOKEN=${gitToken.value}`);
    const body = {project: project.value.trim(), image: image.value.trim(), env, replicas: Number(replicas.value), cpus: Number(cpus.value), memoryMB: Number(memory.value), restart: restart.value, sticky: sticky.checked,
      hosts: hosts.value.split(',').map(h => h.trim().toLowerCase()).filter(Boolean), users: users.value.split(',').map(u => u.trim()).filter(Boolean)};
    if (!confirm(`Create ${body.project}_faas with ${body.replicas} replica(s)?`)) return;
    const r = await api('/services', body); message(`${r.message} Hostnames: ${r.hosts.join(', ')}.${r.warnings?.length ? ' ' + r.warnings.join(' ') : ''}`);
    await loadServices(); await openService(r.id);
  }); };
  content.append(form);
}

run(async () => { try { signedIn(await api('/session')); await loadServices(); } catch (e) { signedOut(); if (e.message !== 'Please sign in') throw e; } });
