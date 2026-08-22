import { DISCLAIMER } from '../shared/disclaimer.js'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Health dashboard, served by the bridge itself on GET /.
// No build step: a single string, no external dependencies.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>whatsapp-agent</title>
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
  h2 {
    font-size: 0.95rem;
    font-weight: 600;
    margin: 0 0 0.75rem;
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
  .banner pre {
    white-space: pre-wrap;
    font-family: inherit;
    font-size: 0.85rem;
    margin: 0 0 0.9rem;
  }
  .banner button {
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.5rem 0.9rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--green);
    color: #fff;
    cursor: pointer;
  }
  #qrPanel {
    text-align: center;
    margin-bottom: 1.25rem;
  }
  #qrPanel img {
    background: #fff;
    padding: 12px;
    border-radius: 8px;
    max-width: 240px;
    width: 100%;
  }
  #qrPanel .sub {
    font-size: 0.78rem;
    color: var(--muted);
    margin-top: 0.5rem;
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
  section.card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.1rem 1.2rem;
    margin-top: 1.25rem;
  }
  .scope-row {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.4rem 0;
  }
  .scope-row label {
    font-size: 0.88rem;
    font-weight: 600;
  }
  .scope-row .help {
    font-size: 0.78rem;
    color: var(--muted);
    font-weight: 400;
    display: block;
  }
  .scope-row input { margin-top: 0.2rem; }
  #applyPermissions {
    margin-top: 0.6rem;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.5rem 0.9rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--text);
    cursor: pointer;
  }
  #permissionsNote {
    font-size: 0.78rem;
    color: var(--muted);
    margin-top: 0.5rem;
  }
  #clientsList {
    font-size: 0.9rem;
  }
  footer {
    margin-top: 1.5rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .stale { opacity: 0.45; }
  .hidden { display: none; }
</style>
</head>
<body>
<main>
  <h1><span id="dot" class="dot"></span> whatsapp-agent <span id="badge" class="badge"></span></h1>

  <div id="disclaimerPanel" class="banner info hidden">
    <pre>${escapeHtml(DISCLAIMER)}</pre>
    <button id="acceptBtn" type="button">I understand — continue</button>
  </div>

  <div id="qrPanel" class="hidden">
    <h2>Scan this from WhatsApp → Settings → Linked devices → Link a device</h2>
    <img id="qrImg" alt="WhatsApp linking QR code">
    <div class="sub">Refreshes automatically — no need to reload this page.</div>
  </div>

  <div id="pairing" class="banner info hidden">
    Pairing code: <code id="pairingCode"></code>
  </div>
  <div id="errorBanner" class="banner hidden"></div>

  <div class="grid">
    <div class="cell">
      <div class="label">Account</div>
      <div class="value" id="me">—</div>
    </div>
    <div class="cell">
      <div class="label">Process uptime</div>
      <div class="value" id="uptime">—</div>
    </div>
    <div class="cell">
      <div class="label">Connected to WA</div>
      <div class="value" id="connectedFor">—</div>
    </div>
    <div class="cell">
      <div class="label">History</div>
      <div class="value" id="syncProgress">—</div>
      <div class="sub" id="syncSub"></div>
    </div>
    <div class="cell">
      <div class="label">Chats</div>
      <div class="value" id="chats">—</div>
    </div>
    <div class="cell">
      <div class="label">Messages</div>
      <div class="value" id="messages">—</div>
    </div>
    <div class="cell">
      <div class="label">Contacts</div>
      <div class="value" id="contacts">—</div>
    </div>
  </div>

  <section id="permissionsSection" class="card hidden">
    <h2>What may your AI assistant do?</h2>
    <div class="scope-row">
      <input type="checkbox" id="scope-send" value="send">
      <label for="scope-send">Send<span class="help">Send, reply, react to, edit and delete messages</span></label>
    </div>
    <div class="scope-row">
      <input type="checkbox" id="scope-media" value="media">
      <label for="scope-media">Media<span class="help">Send images, video, audio and documents</span></label>
    </div>
    <div class="scope-row">
      <input type="checkbox" id="scope-chats" value="chats">
      <label for="scope-chats">Chats<span class="help">Mark read, archive, pin, mute, typing indicators</span></label>
    </div>
    <div class="scope-row">
      <input type="checkbox" id="scope-groups" value="groups">
      <label for="scope-groups">Groups<span class="help">Create groups, manage participants, rename, leave</span></label>
    </div>
    <button id="applyPermissions" type="button">Apply</button>
    <div id="permissionsNote">Reading is always allowed. Automated sending is exactly what anti-spam systems look for — grant only what you need.</div>
  </section>

  <section id="clientsSection" class="card hidden">
    <h2>AI tools</h2>
    <div id="clientsList">—</div>
  </section>

  <footer id="footer">loading...</footer>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var token = new URLSearchParams(location.search).get('token');
  var authHeaders = function () { return token ? { Authorization: 'Bearer ' + token } : {}; };

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

  var CONN_LABEL = { open: 'connected', connecting: 'connecting', close: 'disconnected' };
  var SCOPES = ['send', 'media', 'chats', 'groups'];
  var lastQrVersion = null;
  var permissionsDirty = false;
  var clientsLoaded = false;

  function render(data) {
    var dot = $('dot'), badge = $('badge');
    dot.className = 'dot';
    if (data.awaiting_qr) {
      dot.classList.add('qr');
      badge.textContent = 'awaiting link';
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
      ? 'complete'
      : (hs.progress != null ? hs.progress + '%' : (hs.received ? 'in progress' : '—'));
    $('syncSub').textContent = hs.received ? hs.received.toLocaleString() + ' messages received' : '';

    var stored = data.stored || {};
    $('chats').textContent = (stored.chats ?? 0).toLocaleString();
    $('messages').textContent = (stored.messages ?? 0).toLocaleString();
    $('contacts').textContent = (stored.contacts ?? 0).toLocaleString();

    var pairing = $('pairing');
    if (data.pairing_code) {
      pairing.classList.remove('hidden');
      $('pairingCode').textContent = data.pairing_code;
    } else {
      pairing.classList.add('hidden');
    }

    var errBox = $('errorBanner');
    if (data.last_error && data.connection !== 'open') {
      errBox.classList.remove('hidden');
      errBox.textContent = 'Last error: ' + data.last_error;
    } else {
      errBox.classList.add('hidden');
    }

    // Disclaimer gates linking and permissions — same as the server side.
    $('disclaimerPanel').classList.toggle('hidden', Boolean(data.disclaimer_accepted));
    $('qrPanel').classList.toggle('hidden', !(data.disclaimer_accepted && data.awaiting_qr));
    $('permissionsSection').classList.toggle('hidden', !data.disclaimer_accepted);

    if (data.disclaimer_accepted && data.awaiting_qr && data.qr_version !== lastQrVersion) {
      lastQrVersion = data.qr_version;
      var qrUrl = '/qr.svg?v=' + data.qr_version + (token ? '&token=' + encodeURIComponent(token) : '');
      $('qrImg').src = qrUrl;
    }

    if (data.permissions && !permissionsDirty) {
      var scopes = data.permissions.scopes || [];
      SCOPES.forEach(function (s) {
        $('scope-' + s).checked = scopes.indexOf(s) !== -1;
      });
    }

    if (data.disclaimer_accepted && !clientsLoaded) {
      clientsLoaded = true;
      loadClients();
    }

    $('footer').textContent = 'updated ' + new Date().toLocaleTimeString();
    document.body.classList.remove('stale');

    return data;
  }

  function loadClients() {
    fetch('/clients', { headers: authHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var clients = data.clients || [];
        var section = $('clientsSection');
        if (clients.length === 0) {
          section.classList.add('hidden');
          return;
        }
        section.classList.remove('hidden');
        var names = clients.map(function (c) {
          return c.label + (c.commandExists === false ? ' (binary path missing — reinstall)' : '');
        });
        $('clientsList').textContent = names.join(', ') + '. Restart them to pick up the change.';
      })
      .catch(function () { /* not critical — leave the section as-is */ });
  }

  $('acceptBtn').addEventListener('click', function () {
    fetch('/disclaimer/accept', { method: 'POST', headers: authHeaders() }).then(poll);
  });

  $('applyPermissions').addEventListener('click', function () {
    var scopes = SCOPES.filter(function (s) { return $('scope-' + s).checked; });
    if (scopes.length > 0 && !confirm(
      'Grant ' + scopes.join(', ') + '? Automated sending can get a WhatsApp account banned or restricted.'
    )) {
      return;
    }
    permissionsDirty = true;
    fetch('/permissions', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ scopes: scopes }),
    })
      .then(function () {
        permissionsDirty = false;
        poll();
      })
      .catch(function () { permissionsDirty = false; });
  });

  function poll() {
    var opts = { cache: 'no-store', headers: authHeaders() };
    return fetch('/status', opts)
      .then(function (r) {
        if (r.status === 401) throw new Error('unauthorized');
        return r.json();
      })
      .then(render)
      .then(function (data) {
        scheduleNext(data && data.awaiting_qr ? 1500 : 4000);
      })
      .catch(function (err) {
        document.body.classList.add('stale');
        $('footer').textContent = err && err.message === 'unauthorized'
          ? 'missing or invalid token — open the dashboard URL printed when the bridge started'
          : 'could not reach /status — the bridge may be down';
        scheduleNext(4000);
      });
  }

  var timer = null;
  function scheduleNext(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(poll, ms);
  }

  poll();
})();
</script>
</body>
</html>
`
