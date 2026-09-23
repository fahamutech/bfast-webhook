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
function row(entry = '=') {
  const i = entry.indexOf('='), wrapper = document.createElement('div'); wrapper.className = 'env-row';
  const key = document.createElement('input'); key.value = entry.slice(0,i); key.placeholder = 'VARIABLE_NAME'; key.setAttribute('aria-label','Variable name'); key.required = true; key.pattern = '[A-Za-z_][A-Za-z0-9_]*';
  const value = document.createElement('textarea'); value.value = entry.slice(i+1); value.setAttribute('aria-label','Variable value'); value.hidden = true; value.autocomplete = 'off';
  const masked = document.createElement('input'); masked.type = 'password'; masked.value = 'hidden-value'; masked.readOnly = true; masked.setAttribute('aria-label','Hidden variable value');
  const holder = document.createElement('div'); holder.append(masked,value);
  const reveal = document.createElement('button'); reveal.type = 'button'; reveal.className = 'secondary'; reveal.textContent = 'Reveal'; reveal.onclick = () => {value.hidden = !value.hidden; masked.hidden = !value.hidden; reveal.textContent = value.hidden ? 'Reveal' : 'Hide';};
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = 'Remove'; remove.onclick = () => wrapper.remove();
  wrapper.append(key,holder,reveal,remove); wrapper.env = () => key.value + '=' + value.value; $('envs').append(wrapper);
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
  const updatePath = () => {path.textContent = 'Container path: /run/secrets/' + target.value + ' — set the relevant environment variable to this path if your app supports it.';}; target.oninput = updatePath; updatePath(); wrapper.append(path);
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
