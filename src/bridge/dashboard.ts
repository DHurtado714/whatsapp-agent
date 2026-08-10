// Dashboard de salud, servido por el propio bridge en GET /.
// Sin build step: un solo string, sin dependencias externas.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wa-bridge</title>
<style>
  :root {
    --bg: #f7f5f2;
    --card: #ffffff;
    --border: #e6e2db;
    --text: #1c1b19;
    --muted: #78736a;
    --green: #2f7a4d;
    --yellow: #a97a1f;
    --blue: #2f5f9e;
    --red: #b03a3a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161513;
      --card: #201f1c;
      --border: #322f2a;
      --text: #efeae2;
      --muted: #948d80;
      --green: #5fbf83;
      --yellow: #d9a441;
      --blue: #6f9fdb;
      --red: #e07070;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2.5rem 1.5rem;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main { max-width: 720px; margin: 0 auto; }
  h1 {
    font-size: 1.05rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0 0 1.5rem;
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .dot {
    width: 9px; height: 9px; border-radius: 50%;
    background: var(--muted);
    flex: none;
  }
  .dot.open { background: var(--green); }
  .dot.connecting { background: var(--yellow); }
  .dot.qr { background: var(--blue); }
  .dot.close { background: var(--red); }
  .badge {
    font-size: 0.8rem;
    color: var(--muted);
    font-weight: 500;
  }
  .banner {
    border: 1px solid var(--border);
    border-left: 3px solid var(--red);
    background: var(--card);
    padding: 0.9rem 1rem;
    border-radius: 6px;
    margin-bottom: 1.25rem;
    font-size: 0.85rem;
    color: var(--text);
  }
  .banner.info { border-left-color: var(--blue); }
  .banner code {
    font-size: 1.1rem;
    font-weight: 700;
    letter-spacing: 0.08em;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .cell {
    background: var(--card);
    padding: 1rem 1.1rem;
  }
  .cell .label {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin-bottom: 0.35rem;
  }
  .cell .value {
    font-size: 1.15rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .cell .sub {
    font-size: 0.78rem;
    color: var(--muted);
    margin-top: 0.15rem;
  }
  footer {
    margin-top: 1.5rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .stale { opacity: 0.45; }
</style>
</head>
<body>
<main>
  <h1><span id="dot" class="dot"></span> wa-bridge <span id="badge" class="badge"></span></h1>

  <div id="pairing" class="banner info" style="display:none">
    Código de vinculación: <code id="pairingCode"></code>
  </div>
  <div id="errorBanner" class="banner" style="display:none"></div>

  <div class="grid">
    <div class="cell">
      <div class="label">Cuenta</div>
      <div class="value" id="me">—</div>
    </div>
    <div class="cell">
      <div class="label">Proceso corriendo</div>
      <div class="value" id="uptime">—</div>
    </div>
    <div class="cell">
      <div class="label">Conectado a WA</div>
      <div class="value" id="connectedFor">—</div>
    </div>
    <div class="cell">
      <div class="label">Historial</div>
      <div class="value" id="syncProgress">—</div>
      <div class="sub" id="syncSub"></div>
    </div>
    <div class="cell">
      <div class="label">Chats</div>
      <div class="value" id="chats">—</div>
    </div>
    <div class="cell">
      <div class="label">Mensajes</div>
      <div class="value" id="messages">—</div>
    </div>
    <div class="cell">
      <div class="label">Contactos</div>
      <div class="value" id="contacts">—</div>
    </div>
  </div>

  <footer id="footer">cargando...</footer>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };

  function fmtDuration(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  var CONN_LABEL = { open: 'conectado', connecting: 'conectando', close: 'desconectado' };

  function render(data) {
    var dot = $('dot'), badge = $('badge');
    dot.className = 'dot';
    if (data.awaiting_qr) {
      dot.classList.add('qr');
      badge.textContent = 'esperando vinculación';
    } else {
      dot.classList.add(data.connection);
      badge.textContent = CONN_LABEL[data.connection] || data.connection;
    }

    $('me').textContent = data.me ? (data.me.name || data.me.id) : '—';
    $('uptime').textContent = fmtDuration(Date.now() - data.process_started_at);
    $('connectedFor').textContent = data.connected_at
      ? fmtDuration(Date.now() - data.connected_at)
      : '—';

    var hs = data.history_sync || {};
    $('syncProgress').textContent = hs.complete
      ? 'completo'
      : (hs.progress != null ? hs.progress + '%' : (hs.received ? 'en curso' : '—'));
    $('syncSub').textContent = hs.received ? hs.received.toLocaleString('es') + ' mensajes recibidos' : '';

    var stored = data.stored || {};
    $('chats').textContent = (stored.chats ?? 0).toLocaleString('es');
    $('messages').textContent = (stored.messages ?? 0).toLocaleString('es');
    $('contacts').textContent = (stored.contacts ?? 0).toLocaleString('es');

    var pairing = $('pairing');
    if (data.pairing_code) {
      pairing.style.display = '';
      $('pairingCode').textContent = data.pairing_code;
    } else {
      pairing.style.display = 'none';
    }

    var errBox = $('errorBanner');
    if (data.last_error && data.connection !== 'open') {
      errBox.style.display = '';
      errBox.textContent = 'Último error: ' + data.last_error;
    } else {
      errBox.style.display = 'none';
    }

    $('footer').textContent = 'actualizado ' + new Date().toLocaleTimeString('es');
    document.body.classList.remove('stale');
  }

  function poll() {
    fetch('/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {
        document.body.classList.add('stale');
        $('footer').textContent = 'no se pudo consultar /status — el bridge puede estar caído';
      });
  }

  poll();
  setInterval(poll, 4000);
})();
</script>
</body>
</html>
`
