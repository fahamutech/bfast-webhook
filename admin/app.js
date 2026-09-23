const $ = id => document.getElementById(id);
let csrf, selected;
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error',error); }
function signedOut() { csrf = null; selected = null; $('envs').replaceChildren(); $('services').replaceChildren(); $('editor').hidden = true; $('workspace').hidden = true; $('logout').hidden = true; $('login').hidden = false; }
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
  const s = await api('/services/' + encodeURIComponent(id)); selected = s;
  $('service-name').textContent = s.name; $('image').textContent = 'Image: ' + s.image;
  $('envs').replaceChildren(); s.env.forEach(row);
  $('replicas').value = s.replicas; $('cpus').value = s.cpus; $('memory').value = s.memoryMB; $('restart').value = s.restart;
  $('editor').hidden = false; $('editor').scrollIntoView({behavior:'smooth'});
}
$('login').onsubmit = e => {e.preventDefault(); run(async () => {const password = $('password').value; $('password').value = ''; const data = await api('/login',{password}); csrf = data.csrf; message('Signed in. Sessions expire after 30 minutes.'); await list();});};
$('logout').onclick = () => run(async () => {await api('/logout',{}); signedOut(); message('Signed out.');});
$('refresh').onclick = () => run(list);
$('close').onclick = () => {selected = null; $('envs').replaceChildren(); $('editor').hidden = true;};
$('add-env').onclick = () => row();
$('editor').onsubmit = e => {e.preventDefault(); run(async () => {
  const target = selected;
  if (!target || !confirm(`Save configuration and redeploy ${target.name}?`)) return;
  $('save').disabled = true;
  try {
    const result = await api('/services/' + encodeURIComponent(target.id),{version:target.version,env:[...$('envs').children].map(r => r.env()),replicas:Number($('replicas').value),cpus:Number($('cpus').value),memoryMB:Number($('memory').value),restart:$('restart').value});
    message(result.message + (result.warnings.length ? ' ' + result.warnings.join(' ') : ''));
    await open(target.id); await list();
  } finally {$('save').disabled = false;}
});};
run(async () => {try {csrf = (await api('/session')).csrf; await list();} catch(e) {signedOut(); if (e.message !== 'Please sign in') throw e;}});
