const revealTargets = document.querySelectorAll('[data-reveal]');
const reveal = target => { target.classList.add('is-visible'); observer.unobserve(target); };
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) reveal(entry.target);
}, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
revealTargets.forEach(target => observer.observe(target));

// Red de seguridad: si el observer no dispara (pestaña en segundo plano al cargar,
// una implementación rara del navegador), el contenido no debe quedar invisible
// para siempre — se revela igual pasado un momento.
setTimeout(() => revealTargets.forEach(target => target.classList.add('is-visible')), 1800);
