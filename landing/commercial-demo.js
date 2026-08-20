document.querySelectorAll('details').forEach(item => item.addEventListener('toggle', () => {
  if (item.open) document.querySelectorAll('details').forEach(other => { if (other !== item) other.open = false; });
}));

document.querySelector('#contact-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, status = document.querySelector('#form-status'), button = form.querySelector('button');
  status.textContent = 'Enviando…';
  button.disabled = true;
  try {
    const response = await fetch('/api/leads', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudo enviar.');
    form.reset();
    status.textContent = 'Listo. Recibimos tus datos y te contactaremos.';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

// Revelado en scroll: cada sección aparece una sola vez, sin depender de una librería aparte.
// Nunca debe dejar contenido permanentemente invisible: si el observer no dispara por lo que sea
// (navegador raro, pestaña en segundo plano, tab restaurado con scroll ya hecho), un respaldo por
// tiempo revela todo igual — el peor caso es perder la animación, nunca perder el contenido.
const revealTargets = document.querySelectorAll('[data-reveal], [data-reveal-group]');
if (revealTargets.length && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
  revealTargets.forEach(target => observer.observe(target));
  setTimeout(() => revealTargets.forEach(target => target.classList.add('is-visible')), 2500);
} else {
  revealTargets.forEach(target => target.classList.add('is-visible'));
}
