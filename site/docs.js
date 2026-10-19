// Docs: mobile menu and "on this page" highlighting.
(() => {
  const toggle = document.querySelector('[data-docs-toggle]'), nav = document.getElementById('docs-nav');
  toggle?.addEventListener('click', () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', open); nav.classList.toggle('open', open); });
  const links = [...document.querySelectorAll('.toc a')];
  if (!links.length) return;
  const map = new Map(links.map(a => [decodeURIComponent(a.hash.slice(1)), a]));
  const io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { links.forEach(a => a.classList.remove('on')); map.get(e.target.id)?.classList.add('on'); }
  }, {rootMargin: '-80px 0px -70% 0px'});
  document.querySelectorAll('.prose h2[id], .prose h3[id]').forEach(h => io.observe(h));
})();
