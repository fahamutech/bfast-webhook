const $ = id => document.getElementById(id);
let csrf, selected, availableSecrets = [];
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error',error); }
function signedOut() { csrf = null; selected = null; $('envs').replaceChildren(); $('services').replaceChildren(); clearSecrets(); $('editor').hidden = true; $('workspace').hidden = true; $('logout').hidden = true; $('login').hidden = false; }
async function api(path, body) {
  const res = await fetch('/admin/api' + path, {method:body === undefined ? 'GET' : 'POST', credentials:'same-origin', cache:'no-store', headers:body === undefined ? {} : {'Content-Type':'application/json','X-CSRF-Token':csrf || ''}, body:body === undefined ? undefined : JSON.stringify(body)});
  const data = await res.json();
  if (!res.ok) { if (res.status === 401) signedOut(); throw new Error(data.error || 'Request failed'); }
  return data;
}
async function run(action) { try {await action();} catch(e) {message(e.message,true);} }
async function list() {
  const services = await api('/services');
  $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
  $('services').replaceChildren();
  if (!services.length) $('services').textContent = 'No editable application services found.';
  for (const s of services) {
    const b = document.createElement('button'); b.className = 'service'; b.textContent = s.name;
    const detail = document.createElement('small'); detail.textContent = `${s.replicas} desired replica${s.replicas === 1 ? '' : 's'} · Open settings →`; b.append(detail);
    b.onclick = () => run(() => open(s.id)); $('services').append(b);
  }
}
const ENV_MAX = 131000, B64_HINT = /(b64|base64)/i, B64_LIKELY = /(cert|pem|key|keystore|credential|secret|json)/i;
const utf8 = new TextDecoder('utf-8', {fatal:true});
const cleanB64 = v => v.replace(/\s+/g,'');
const validB64 = v => { const c = cleanB64(v); return c.length > 0 && c.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(c); };
const toB64 = bytes => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(bin); };
const fromB64 = v => Uint8Array.from(atob(cleanB64(v)), c => c.charCodeAt(0));
function decodedText(bytes) { try {const t = utf8.decode(bytes); return /[\x00-\x08\x0e-\x1f]/.test(t) ? null : t;} catch {return null;} }
const size = n => n < 1024 ? n + ' B' : (n/1024).toFixed(1) + ' KB';
function guessKind(key, value) {
  if (!value) return B64_HINT.test(key) ? 'base64' : 'text';
  if (!validB64(value) || cleanB64(value).length < 16) return 'text';
  if (B64_HINT.test(key) || B64_LIKELY.test(key)) return 'base64';
  try {return decodedText(fromB64(value)) !== null && !/^[0-9]+$/.test(value) && !/\s/.test(value.trim()) ? 'base64' : 'text';} catch {return 'text';}
}
function mk(tag, props = {}, ...kids) { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; }
function row(entry = '=') {
  const i = entry.indexOf('='), wrapper = mk('div', {className:'env-row'});
  const key = mk('input', {value:entry.slice(0,i), placeholder:'VARIABLE_NAME', required:true, pattern:'[A-Za-z_][A-Za-z0-9_]*'}); key.setAttribute('aria-label','Variable name');
  const value = mk('textarea', {value:entry.slice(i+1), hidden:true, autocomplete:'off', spellcheck:false}); value.setAttribute('aria-label','Variable value');
  const masked = mk('input', {type:'password', value:'hidden-value', readOnly:true}); masked.setAttribute('aria-label','Hidden variable value');
  const type = mk('select', {}, ...[['text','Text'],['file','File'],['base64','Base64']].map(([v,t]) => mk('option', {value:v, textContent:t}))); type.setAttribute('aria-label','Value type');
  type.value = guessKind(key.value, value.value);
  let typeTouched = type.value !== 'text', fileName = '';
  const picker = mk('input', {type:'file', hidden:true});
  const status = mk('small', {className:'muted env-status'});
  const upload = mk('button', {type:'button', className:'secondary', onclick:() => picker.click()});
  const view = mk('button', {type:'button', className:'secondary', textContent:'View decoded'});
  const download = mk('button', {type:'button', className:'secondary', textContent:'Download'});
  const reveal = mk('button', {type:'button', className:'secondary', textContent:'Reveal'});
  const remove = mk('button', {type:'button', className:'secondary', textContent:'Remove', onclick:() => wrapper.remove()});
  const preview = mk('pre', {className:'env-preview', hidden:true});
  const tools = mk('div', {className:'env-tools'}, upload, view, download, status);
  const holder = mk('div', {}, masked, value, tools, picker, preview);
  function refresh() {
    const k = type.value;
    upload.textContent = k === 'base64' ? 'Upload file → Base64' : k === 'file' ? (fileName ? 'Replace file' : 'Choose file') : 'Load from file';
    view.hidden = download.hidden = k !== 'base64';
    value.placeholder = k === 'base64' ? 'Paste Base64 here, or upload a file to convert it' : k === 'file' ? 'File contents appear here after choosing a file' : 'Value';
    let text = '';
    if (k === 'base64' && value.value) {
      if (!validB64(value.value)) text = '⚠ Not valid Base64';
      else { const n = Math.floor(cleanB64(value.value).length * 3 / 4); text = size(n) + ' decoded'; }
    } else if (k === 'file' && fileName) text = fileName + ' · ' + size(value.value.length);
    else if (value.value) text = size(value.value.length);
    status.textContent = text; status.classList.toggle('error', text.startsWith('⚠'));
    if (!preview.hidden) showPreview();
  }
  function decoded() { if (!validB64(value.value)) throw new Error('Value is not valid Base64.'); return fromB64(value.value); }
  function showPreview() {
    try {const bytes = decoded(), t = decodedText(bytes); preview.textContent = t ?? `Binary data · ${size(bytes.length)}\n${[...bytes.subarray(0,64)].map(b => b.toString(16).padStart(2,'0')).join(' ')}${bytes.length > 64 ? ' …' : ''}`;}
    catch(e) {preview.textContent = e.message;}
  }
  view.onclick = () => {preview.hidden = !preview.hidden; view.textContent = preview.hidden ? 'View decoded' : 'Hide decoded'; if (!preview.hidden) showPreview();};
  download.onclick = () => run(async () => {const bytes = decoded(), a = mk('a', {href:URL.createObjectURL(new Blob([bytes])), download:(key.value || 'value') + '.bin'}); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);});
  reveal.onclick = () => {value.hidden = !value.hidden; masked.hidden = !value.hidden; reveal.textContent = value.hidden ? 'Reveal' : 'Hide';};
  picker.onchange = () => run(async () => {
    const f = picker.files[0]; picker.value = ''; if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer()); let text = null;
    if (type.value !== 'base64') { text = decodedText(bytes);
      if (text === null) { type.value = 'base64'; typeTouched = true; message(`${f.name} is binary, so it was converted to Base64.`); } }
    const next = type.value === 'base64' ? toB64(bytes) : text;
    if (next.length > ENV_MAX) return message(`${f.name} is too large for an environment variable (limit ${size(ENV_MAX)} after encoding).`, true);
    value.value = next; fileName = f.name; if (type.value === 'text') {type.value = 'file'; typeTouched = true;}
    value.hidden = false; masked.hidden = true; reveal.textContent = 'Hide'; refresh();
  });
  type.onchange = () => {
    typeTouched = true; const v = value.value;
    if (type.value === 'base64' && v && !validB64(v)) { try {value.value = toB64(new TextEncoder().encode(v));} catch {} }
    else if (type.value !== 'base64' && v && validB64(v) && guessKind(key.value,v) === 'base64') { try {const t = decodedText(fromB64(v)); if (t !== null) value.value = t;} catch {} }
    refresh();
  };
  key.oninput = () => { if (!typeTouched && !value.value && B64_HINT.test(key.value)) {type.value = 'base64'; refresh();} };
  value.oninput = () => { if (!typeTouched && type.value === 'text' && guessKind(key.value,value.value) === 'base64') {type.value = 'base64';} refresh(); };
  value.onpaste = () => setTimeout(() => { if (type.value === 'base64' && validB64(value.value)) value.value = cleanB64(value.value); refresh(); });
  wrapper.append(key,type,holder,reveal,remove);
  wrapper.env = () => {
    let v = value.value;
    if (type.value === 'base64' && v) { if (!validB64(v)) {key.reportValidity(); throw new Error(`${key.value || 'Variable'} is not valid Base64.`);} v = cleanB64(v); }
    if (v.length > ENV_MAX) throw new Error(`${key.value} is too large (limit ${size(ENV_MAX)}).`);
    return key.value + '=' + v;
  };
  refresh(); $('envs').append(wrapper);
}
async function open(id) {
  const s = await api('/services/' + encodeURIComponent(id));
  const choices = await api('/services/' + encodeURIComponent(id) + '/secrets');
  selected = s; clearSecrets(); availableSecrets = choices; renderSecretChoices();
  (s.secrets || []).forEach(secretRow);
  $('service-name').textContent = s.name; $('image').textContent = 'Image: ' + s.image;
  $('envs').replaceChildren(); s.env.forEach(row);
  $('replicas').value = s.replicas; $('cpus').value = s.cpus; $('memory').value = s.memoryMB; $('restart').value = s.restart;
  $('editor').hidden = false; $('editor').scrollIntoView({behavior:'smooth'});
}
$('login').onsubmit = e => {e.preventDefault(); run(async () => {const password = $('password').value; $('password').value = ''; const data = await api('/login',{password}); csrf = data.csrf; message('Signed in. Sessions expire after 30 minutes.'); await list();});};
$('logout').onclick = () => run(async () => {await api('/logout',{}); signedOut(); message('Signed out.');});
$('refresh').onclick = () => run(list);
$('close').onclick = () => {selected = null; $('envs').replaceChildren(); clearSecrets(); $('editor').hidden = true;};
$('add-env').onclick = () => row();
$('editor').onsubmit = e => {e.preventDefault(); run(async () => {
  const target = selected;
  if (!target || !confirm(`Save configuration and redeploy ${target.name}?`)) return;
  $('save').disabled = true;
  try {
    const result = await api('/services/' + encodeURIComponent(target.id),{version:target.version,env:[...$('envs').children].map(r => r.env()),replicas:Number($('replicas').value),cpus:Number($('cpus').value),memoryMB:Number($('memory').value),restart:$('restart').value,secrets:[...$('secret-mounts').children].map(r => r.secret())});
    message(result.message + (result.warnings.length ? ' ' + result.warnings.join(' ') : ''));
    await open(target.id); await list();
  } finally {$('save').disabled = false;}
});};
run(async () => {try {csrf = (await api('/session')).csrf; await list();} catch(e) {signedOut(); if (e.message !== 'Please sign in') throw e;}});

function clearSecrets() {
  availableSecrets = []; $('secret-choice').replaceChildren(); $('secret-mounts').replaceChildren();
  $('secret-name').value = ''; $('secret-value').value = '';
}
function renderSecretChoices() {
  $('secret-choice').replaceChildren();
  for (const s of availableSecrets) {const option = document.createElement('option'); option.value = s.id; option.textContent = s.name; $('secret-choice').append(option);}
  $('attach-secret').disabled = !availableSecrets.length;
}
function secretRow(secret) {
  const wrapper = document.createElement('div'); wrapper.className = 'secret-mount';
  const heading = document.createElement('p'); heading.textContent = secret.name || secret.id; wrapper.append(heading);
  const fields = document.createElement('div'); fields.className = 'settings'; wrapper.append(fields);
  function field(title, value) {const label = document.createElement('label'); label.textContent = title; const input = document.createElement('input'); input.value = value; input.required = true; label.append(input); fields.append(label); return input;}
  const target = field('Filename under /run/secrets/',secret.target || 'secret'); target.pattern = '[A-Za-z0-9](?:[A-Za-z0-9_.]|-){0,127}';
  const uid = field('Owner UID',secret.uid ?? '0'); uid.pattern = '[0-9]+';
  const gid = field('Group GID',secret.gid ?? '0'); gid.pattern = '[0-9]+';
  const label = document.createElement('label'); label.textContent = 'Read permissions';
  const mode = document.createElement('select');
  for (const [value,title] of [[256,'0400 · owner'],[288,'0440 · owner + group'],[292,'0444 · everyone']]) {const o = document.createElement('option'); o.value = value; o.textContent = title; mode.append(o);}
  mode.value = secret.mode ?? 256; label.append(mode); fields.append(label);
  const path = document.createElement('p'); path.className = 'muted';
  const updatePath = () => {path.textContent = 'Container path: /run/secrets/' + target.value + ' — in current BFast Functions, set an environment variable to this path and BFast loads the secret value at startup.';}; target.oninput = updatePath; updatePath(); wrapper.append(path);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = 'Detach on save'; remove.onclick = () => wrapper.remove(); wrapper.append(remove);
  wrapper.secret = () => ({id:secret.id,target:target.value,uid:uid.value,gid:gid.value,mode:Number(mode.value)});
  $('secret-mounts').append(wrapper);
}
$('attach-secret').onclick = () => {
  const s = availableSecrets.find(s => s.id === $('secret-choice').value); if (!s) return;
  if ([...$('secret-mounts').children].some(r => r.secret().id === s.id)) return message('This secret is already attached.',true);
  secretRow({...s,target:s.name});
};
$('create-secret').onclick = () => run(async () => {
  if (!selected) return;
  const id = selected.id, value = $('secret-value').value, name = $('secret-name').value;
  $('secret-value').value = ''; $('create-secret').disabled = true;
  try {
    const result = await api('/services/' + encodeURIComponent(id) + '/secrets',{name,value});
    if (selected?.id !== id) return;
    availableSecrets.push(result); renderSecretChoices(); $('secret-choice').value = result.id;
    $('secret-name').value = ''; message('Secret created. Choose Attach secret, set its filename, then Save & redeploy.');
  } finally {$('create-secret').disabled = false;}
});
