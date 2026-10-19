// BFast Cloud website interactions. No dependencies; respects prefers-reduced-motion.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ---------- Nav ----------
  const nav = $('[data-nav]'), menu = $('[data-menu]'), links = $('#nav-links');
  const onScroll = () => nav?.classList.toggle('scrolled', scrollY > 12);
  addEventListener('scroll', onScroll, {passive: true}); onScroll();
  menu?.addEventListener('click', () => { const open = menu.getAttribute('aria-expanded') !== 'true'; menu.setAttribute('aria-expanded', open); links.classList.toggle('open', open); });
  links?.addEventListener('click', e => { if (e.target.closest('a')) { menu?.setAttribute('aria-expanded', 'false'); links.classList.remove('open'); } });

  // ---------- Copy buttons ----------
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-copy]'); if (!btn) return;
    const text = btn.dataset.copy || btn.closest('.code')?.querySelector('pre')?.innerText || '';
    try { await navigator.clipboard.writeText(text); } catch { const t = Object.assign(document.createElement('textarea'), {value: text}); document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
    const label = btn.querySelector('[data-copy-label]') || btn, before = label.textContent;
    label.textContent = 'Copied ✓'; setTimeout(() => { label.textContent = before; }, 1400);
  });

  if (!document.body.classList.contains('home')) return;

  // ---------- Cursor glow, magnetic buttons, glow cards, tilt ----------
  const cursor = $('.cursor');
  if (fine && !reduce) {
    let x = -999, y = -999, cx = x, cy = y;
    addEventListener('pointermove', e => { x = e.clientX; y = e.clientY; }, {passive: true});
    const loop = () => { cx += (x - cx) * .12; cy += (y - cy) * .12; cursor.style.setProperty('--cx', cx + 'px'); cursor.style.setProperty('--cy', cy + 'px'); requestAnimationFrame(loop); };
    loop();
    for (const el of $$('[data-magnetic]')) {
      el.addEventListener('pointermove', e => { const r = el.getBoundingClientRect(); el.style.setProperty('--mx', (e.clientX - r.left - r.width / 2) * .18 + 'px'); el.style.setProperty('--my', (e.clientY - r.top - r.height / 2) * .28 + 'px'); });
      el.addEventListener('pointerleave', () => { el.style.setProperty('--mx', '0px'); el.style.setProperty('--my', '0px'); });
    }
    const mock = $('[data-tilt]');
    mock?.addEventListener('pointermove', e => { const r = mock.getBoundingClientRect(), px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5; mock.style.setProperty('--ry', px * 10 + 'deg'); mock.style.setProperty('--rx', -py * 8 + 'deg'); });
    mock?.addEventListener('pointerleave', () => { mock.style.removeProperty('--ry'); mock.style.removeProperty('--rx'); });
  } else cursor?.remove();
  for (const el of $$('[data-glow]')) el.addEventListener('pointermove', e => { const r = el.getBoundingClientRect(); el.style.setProperty('--gx', e.clientX - r.left + 'px'); el.style.setProperty('--gy', e.clientY - r.top + 'px'); });

  // ---------- Kinetic type: split into letters, weight follows the cursor ----------
  const split = el => {
    let i = 0;
    const walk = node => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const word of child.textContent.split(/(\s+)/)) {
            if (!word) continue;
            if (/^\s+$/.test(word)) { frag.append(' '); continue; }
            const w = document.createElement('span'); w.style.whiteSpace = 'nowrap';
            for (const c of word) { const s = document.createElement('span'); s.className = 'ch'; s.textContent = c; s.style.setProperty('--i', i++); w.append(s); }
            frag.append(w);
          }
          child.replaceWith(frag);
        } else if (child.nodeType === 1 && !child.classList.contains('swap') && child.tagName !== 'BR') walk(child);
        else if (child.classList?.contains('swap')) { child.style.setProperty('--i', i); child.classList.add('ch'); i += 4; }
      }
    };
    walk(el);
  };
  for (const el of $$('[data-kinetic]')) {
    split(el);
    if (fine && !reduce) {
      const chars = $$('.ch', el);
      el.addEventListener('pointermove', e => { for (const c of chars) { const r = c.getBoundingClientRect(), d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)); c.style.setProperty('--w', Math.round(700 - Math.min(d, 260) / 260 * 400)); } });
      el.addEventListener('pointerleave', () => chars.forEach(c => c.style.removeProperty('--w')));
    }
  }
  const swap = $('[data-swap]');
  if (swap && !reduce) {
    const words = swap.dataset.swap.split('|'); let n = 0;
    setInterval(() => { n = (n + 1) % words.length; swap.innerHTML = ''; const w = document.createElement('span'); w.className = 'word'; w.textContent = words[n]; swap.append(w); }, 2400);
  }

  // ---------- Reveal on scroll ----------
  const io = new IntersectionObserver(entries => { for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }, {rootMargin: '0px 0px -8% 0px', threshold: .12});
  $$('.reveal, [data-kinetic]').forEach(el => {
    const sibs = el.parentElement ? $$(':scope > .reveal', el.parentElement) : [];
    const idx = sibs.indexOf(el); if (idx > 0) el.style.setProperty('--d', Math.min(idx, 6) * 0.08 + 's');
    io.observe(el);
  });
  requestAnimationFrame(() => $('.hero [data-kinetic]')?.classList.add('in'));

  // ---------- Typing terminal ----------
  const typing = $('[data-typing]');
  if (typing) {
    const lines = typing.innerHTML.replace(/^\n/, '').split('\n');
    typing.innerHTML = lines.map(l => `<span class="tl">${l || ' '}</span>`).join('\n');
    const rows = $$('.tl', typing);
    if (reduce) rows.forEach(r => r.classList.add('on'));
    else { let k = 0; const step = () => { if (k < rows.length) { rows[k++].classList.add('on'); setTimeout(step, k === 1 ? 500 : 420 + Math.random() * 380); } else setTimeout(() => { rows.forEach(r => r.classList.remove('on')); k = 0; setTimeout(step, 600); }, 5200); }; setTimeout(step, 700); }
  }

  // ---------- Marquee: duplicate items for a seamless loop ----------
  const track = $('[data-marquee]'); if (track) track.innerHTML += track.innerHTML.replace(/<span>/g, '<span aria-hidden="true">');

  // ---------- Scrollytelling ----------
  const steps = $$('.step'), scenes = $$('.stage .scene'), progress = $('.stage .progress');
  const mobile = matchMedia('(max-width: 860px)');
  const inline = () => {
    for (const step of steps) {
      if (mobile.matches && !$('.scene-inline', step)) { const holder = document.createElement('div'); holder.className = 'scene-inline'; holder.append(scenes[step.dataset.step].cloneNode(true)); step.append(holder); }
      if (!mobile.matches) $('.scene-inline', step)?.remove();
    }
  };
  inline(); mobile.addEventListener('change', inline);
  const setStep = n => {
    steps.forEach(s => s.classList.toggle('active', +s.dataset.step === n));
    scenes.forEach(s => s.classList.toggle('on', +s.dataset.scene === n));
    progress?.style.setProperty('--p', (n + 1) / steps.length);
  };
  const stepIo = new IntersectionObserver(entries => { for (const e of entries) if (e.isIntersecting) setStep(+e.target.dataset.step); }, {rootMargin: '-45% 0px -45% 0px'});
  steps.forEach(s => stepIo.observe(s)); setStep(0);
  // Inline scenes animate when they enter view on phones.
  const inlineIo = new IntersectionObserver(entries => { for (const e of entries) if (e.isIntersecting) e.target.classList.add('on'); }, {threshold: .4});
  const watchInline = () => $$('.scene-inline .scene').forEach(s => { s.classList.remove('on'); inlineIo.observe(s); });
  watchInline(); mobile.addEventListener('change', watchInline);

  // ---------- Function tabs ----------
  const tabs = $$('.fn-tabs [role=tab]');
  const select = t => { tabs.forEach(b => { const on = b === t; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; $('#' + b.getAttribute('aria-controls')).hidden = !on; }); };
  tabs.forEach((t, i) => { t.addEventListener('click', () => select(t)); t.addEventListener('keydown', e => { const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (d) { const n = tabs[(i + d + tabs.length) % tabs.length]; select(n); n.focus(); } }); });
  select(tabs[0]);

  // ---------- Swarm canvas: particles orbit three nodes; one migrates now and then like a rolling update ----------
  const canvas = $('.swarm');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1, parts = [], anchors = [], mouse = {x: -9999, y: -9999}, last = 0;
  const build = () => {
    dpr = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const narrow = W < 760;
    anchors = (narrow ? [[.2, .16], [.82, .34], [.55, .9]] : [[.12, .78], [.6, .14], [.9, .66]]).map(([x, y], i) => ({x: x * W, y: y * H, r: narrow ? 70 : 120, i}));
    const count = Math.round(Math.min(narrow ? 46 : 120, W * H / (narrow ? 9000 : 13000)));
    parts = Array.from({length: count}, (_, k) => {
      const a = anchors[k % anchors.length], ang = Math.random() * Math.PI * 2, rad = a.r * (.35 + Math.random() * .9);
      return {a, ang, rad, speed: (.0012 + Math.random() * .0025) * (Math.random() < .5 ? -1 : 1), x: a.x + Math.cos(ang) * rad, y: a.y + Math.sin(ang) * rad, vx: 0, vy: 0, hot: 0};
    });
  };
  const hex = (x, y, r) => { ctx.beginPath(); for (let i = 0; i < 6; i++) { const t = Math.PI / 3 * i - Math.PI / 6; ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(t) * r, y + Math.sin(t) * r); } ctx.closePath(); };
  const frame = t => {
    const dt = Math.min(48, t - last || 16); last = t;
    ctx.clearRect(0, 0, W, H);
    for (const a of anchors) {
      const g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, a.r * 1.6); g.addColorStop(0, 'rgba(62,230,164,.10)'); g.addColorStop(1, 'rgba(62,230,164,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(a.x, a.y, a.r * 1.6, 0, Math.PI * 2); ctx.fill();
      hex(a.x, a.y, 16); ctx.strokeStyle = 'rgba(62,230,164,.75)'; ctx.lineWidth = 1.5; ctx.stroke();
      hex(a.x, a.y, 5); ctx.fillStyle = 'rgba(62,230,164,.9)'; ctx.fill();
    }
    for (const p of parts) {
      p.ang += p.speed * dt;
      const tx = p.a.x + Math.cos(p.ang) * p.rad, ty = p.a.y + Math.sin(p.ang) * p.rad;
      p.vx += (tx - p.x) * .0016 * dt; p.vy += (ty - p.y) * .0016 * dt;
      const mx = mouse.x - p.x, my = mouse.y - p.y, md = Math.hypot(mx, my);
      if (md < 170 && md > 1) { const f = (1 - md / 170) * .06 * dt; p.vx += mx / md * f; p.vy += my / md * f; }
      p.vx *= .9; p.vy *= .9; p.x += p.vx; p.y += p.vy; p.hot = Math.max(0, p.hot - dt / 1600);
    }
    ctx.lineWidth = 1;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      for (let j = i + 1; j < parts.length; j++) {
        const q = parts[j], dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy;
        if (d2 < 9000) { ctx.strokeStyle = `rgba(160,230,200,${(1 - d2 / 9000) * .22})`; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
      }
    }
    for (const p of parts) {
      ctx.fillStyle = p.hot > 0 ? `rgba(255,199,107,${.5 + p.hot * .5})` : 'rgba(205,240,224,.75)';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.hot > 0 ? 2.6 : 1.6, 0, Math.PI * 2); ctx.fill();
    }
  };
  // The swarm belongs to the hero: it fades out as the hero scrolls away, with or without animation.
  const fadeSwarm = () => canvas.style.setProperty('--swarm-o', Math.max(0, 1 - scrollY / (innerHeight * 1.1)).toFixed(3));
  addEventListener('scroll', fadeSwarm, {passive: true}); fadeSwarm();
  build();
  addEventListener('resize', () => { clearTimeout(build.t); build.t = setTimeout(() => { build(); if (reduce) frame(16); }, 150); });
  addEventListener('pointermove', e => { mouse.x = e.clientX; mouse.y = e.clientY; }, {passive: true});
  addEventListener('pointerleave', () => { mouse.x = mouse.y = -9999; });
  if (reduce) { frame(16); return; }
  // A "rolling update": every few seconds a particle moves to another node and glows while it travels.
  setInterval(() => { if (document.hidden || !parts.length) return; const p = parts[Math.random() * parts.length | 0]; p.a = anchors[(p.a.i + 1 + (Math.random() * 2 | 0)) % anchors.length]; p.hot = 1; }, 900);
  const loop = t => { if (!document.hidden && scrollY < innerHeight * 1.15) frame(t); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
})();
