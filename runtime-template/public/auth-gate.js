(function () {
  var STYLE = '#za-auth-gate{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;'
    + 'background:#1b1b1f;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;box-sizing:border-box}'
    + '#za-auth-gate .card{background:#fff;border-radius:16px;padding:32px 28px;max-width:340px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.35)}'
    + '#za-auth-gate h1{font-size:1.15rem;margin:0 0 6px;color:#1b1b1f}'
    + '#za-auth-gate p.hint{font-size:.85rem;color:#666;margin:0 0 20px}'
    + '#za-auth-gate input{width:100%;box-sizing:border-box;font-size:1.4rem;letter-spacing:.3em;text-align:center;'
    + 'padding:12px 10px;border:1px solid #d8d8d8;border-radius:10px;margin-bottom:12px}'
    + '#za-auth-gate button{width:100%;padding:12px;border:none;border-radius:10px;background:#c56b4c;color:#fff;'
    + 'font-size:1rem;font-weight:600;cursor:pointer}'
    + '#za-auth-gate button:disabled{opacity:.6;cursor:default}'
    + '#za-auth-gate .error{color:#c0392b;font-size:.85rem;min-height:1.2em;margin:0 0 10px}'
    + '#za-auth-gate .step{display:none}'
    + '#za-auth-gate .step.active{display:block}'
    + '#za-logout-btn{position:fixed;bottom:14px;right:14px;z-index:9998;background:#fff;border:1px solid #d8d8d8;'
    + 'border-radius:20px;padding:6px 14px;font-size:.78rem;color:#666;cursor:pointer;font-family:system-ui,sans-serif;'
    + 'box-shadow:0 2px 8px rgba(0,0,0,.08)}'
    // La consola móvil (m/index.html) tiene un tabbar fijo abajo (~56px + safe-area) — el botón de
    // cerrar sesión con bottom:14px le quedaba encima, tapando las últimas pestañas. Solo en
    // viewports angostos (la consola de escritorio no tiene tabbar) lo subimos por sobre esa franja.
    + '@media (max-width:768px){#za-logout-btn{bottom:calc(70px + env(safe-area-inset-bottom,0px))}}';
  var styleTag = document.createElement('style');
  styleTag.textContent = STYLE;
  document.head.appendChild(styleTag);

  var overlay = document.createElement('div');
  overlay.id = 'za-auth-gate';
  overlay.innerHTML =
    '<div class="card">' +
      '<div class="step active" data-step="login">' +
        '<h1>Acceso del equipo</h1>' +
        '<p class="hint">Ingresa tu PIN para entrar.</p>' +
        '<p class="error" data-role="login-error"></p>' +
        '<input type="password" inputmode="numeric" maxlength="8" autocomplete="off" data-role="pin-input" placeholder="••••••">' +
        '<button data-role="login-submit">Entrar</button>' +
      '</div>' +
      '<div class="step" data-step="change">' +
        '<h1>Elige tu PIN</h1>' +
        '<p class="hint">Es tu primer ingreso — reemplaza el PIN temporal por uno propio (4 a 8 dígitos).</p>' +
        '<p class="error" data-role="change-error"></p>' +
        '<input type="password" inputmode="numeric" maxlength="8" autocomplete="off" data-role="new-pin-input" placeholder="Nuevo PIN">' +
        '<input type="password" inputmode="numeric" maxlength="8" autocomplete="off" data-role="new-pin-confirm" placeholder="Repite el PIN">' +
        '<button data-role="change-submit">Guardar PIN</button>' +
      '</div>' +
    '</div>';

  function show(step) {
    overlay.querySelectorAll('.step').forEach(function (el) { el.classList.toggle('active', el.dataset.step === step); });
  }

  function setError(role, message) {
    var el = overlay.querySelector('[data-role="' + role + '"]');
    if (el) el.textContent = message || '';
  }

  async function submitLogin() {
    var pin = overlay.querySelector('[data-role="pin-input"]').value.trim();
    setError('login-error', '');
    if (!pin) return;
    var button = overlay.querySelector('[data-role="login-submit"]');
    button.disabled = true;
    try {
      var response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: pin }) });
      var data = await response.json();
      if (!response.ok) { setError('login-error', data.error || 'PIN incorrecto.'); return; }
      if (data.must_change_pin) { show('change'); return; }
      window.location.reload();
    } catch (error) {
      setError('login-error', 'No se pudo conectar. Intenta de nuevo.');
    } finally {
      button.disabled = false;
    }
  }

  async function submitChangePin() {
    var newPin = overlay.querySelector('[data-role="new-pin-input"]').value.trim();
    var confirmPin = overlay.querySelector('[data-role="new-pin-confirm"]').value.trim();
    setError('change-error', '');
    if (!/^\d{4,8}$/.test(newPin)) { setError('change-error', 'El PIN debe tener entre 4 y 8 dígitos.'); return; }
    if (newPin !== confirmPin) { setError('change-error', 'Los PIN no coinciden.'); return; }
    var button = overlay.querySelector('[data-role="change-submit"]');
    button.disabled = true;
    try {
      var response = await fetch('/api/auth/change-pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ new_pin: newPin }) });
      var data = await response.json();
      if (!response.ok) { setError('change-error', data.error || 'No se pudo guardar el PIN.'); return; }
      window.location.reload();
    } catch (error) {
      setError('change-error', 'No se pudo conectar. Intenta de nuevo.');
    } finally {
      button.disabled = false;
    }
  }

  function wireEvents() {
    overlay.querySelector('[data-role="login-submit"]').addEventListener('click', submitLogin);
    overlay.querySelector('[data-role="pin-input"]').addEventListener('keydown', function (event) { if (event.key === 'Enter') submitLogin(); });
    overlay.querySelector('[data-role="change-submit"]').addEventListener('click', submitChangePin);
    overlay.querySelector('[data-role="new-pin-confirm"]').addEventListener('keydown', function (event) { if (event.key === 'Enter') submitChangePin(); });
  }

  function addLogoutButton() {
    var button = document.createElement('button');
    button.id = 'za-logout-btn';
    button.textContent = 'Cerrar sesión';
    button.addEventListener('click', async function () {
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (error) {}
      window.location.reload();
    });
    document.body.appendChild(button);
  }

  // client-console-v2.js / m.js cargan su propio script en paralelo a este y antes no esperaban
  // a que hubiera sesión — llamaban a la API de inmediato, la pedían con 401, y cada uno mostraba
  // su propio prompt() nativo pidiendo la "clave del dashboard" (un mecanismo viejo, previo al PIN)
  // ENCIMA de esta pantalla de login, bloqueándola por completo. Este evento les avisa cuándo ya
  // hay sesión real para que esperen antes de pedir datos.
  function notifyAuthenticated() {
    // window.zaAuthenticated queda marcado de inmediato (síncrono) para que un script que recién
    // está registrando su listener después de este punto pueda comprobarlo directo, en vez de
    // perderse el evento por una carrera con el fetch async de arriba.
    window.zaAuthenticated = true;
    document.dispatchEvent(new CustomEvent('za-authenticated'));
  }

  async function init() {
    // El overlay sólo se agrega al DOM si hace falta. Antes se montaba siempre de entrada (con el
    // paso "login" visible por defecto) y recién se sacaba cuando /api/auth/session confirmaba la
    // sesión — eso significa que, incluso justo después de un login exitoso (login → reload), la
    // pantalla de PIN parpadeaba visible durante ese round-trip antes de desaparecer. Se sentía
    // como "pide el PIN de nuevo" aunque nunca hacía falta reingresarlo.
    var data = null;
    try {
      var response = await fetch('/api/auth/session');
      data = await response.json();
    } catch (error) {
      // Sin conexión al backend: no se puede verificar sesión, se cae al login por defecto.
    }
    // La página (agenda.html / m/index.html) arranca con su contenido oculto por CSS para que no
    // se vea ni un instante el layout real sin autenticar mientras se resuelve este fetch. Recién
    // acá se revela — con el dashboard real si hay sesión, o con esta pantalla de PIN tapándolo si no.
    document.documentElement.classList.add('za-ready');
    if (data?.authenticated && !data.must_change_pin) { addLogoutButton(); notifyAuthenticated(); return; }
    document.body.appendChild(overlay);
    wireEvents();
    if (data?.authenticated && data.must_change_pin) { show('change'); return; }
    show('login');
    overlay.querySelector('[data-role="pin-input"]').focus();
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
