const mineflayer = require('mineflayer');
const http = require('http');
const url = require('url');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null; // optional auth

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  ip: process.env.MC_IP || null,
  port: parseInt(process.env.MC_PORT) || 25565,
  portSet: !!process.env.MC_PORT,
  botUsername: process.env.MC_USERNAME || 'BotPlayer',
  mcVersion: process.env.MC_VERSION || null,
  mcAuth: process.env.MC_AUTH || 'offline',

  bot: null,
  connected: false,
  autoReconnect: false,
  reconnectTimer: null,

  jumpInterval: null,
  moveInterval: null,
  sneakActive: false,

  joinTime: null,
  disconnectReason: null,
  lastError: null,
  logs: [], // last 20 log entries
};

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(msg) {
  const entry = { time: new Date().toISOString(), msg };
  console.log(`[${entry.time}] ${msg}`);
  state.logs.push(entry);
  if (state.logs.length > 20) state.logs.shift();
}

// ─── Midnight Auto-Update ─────────────────────────────────────────────────────
const { execSync } = require('child_process');

function runPackageUpdate() {
  log('🔄 Midnight auto-update: running npm update...');
  try {
    const output = execSync('npm update --save 2>&1', { timeout: 120000 }).toString().trim();
    log(`✅ npm update done: ${output.split('\n').pop() || 'OK'}`);
  } catch (err) {
    log(`❌ npm update failed: ${err.message}`);
  }
}

function scheduleMidnightUpdate() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setDate(nextMidnight.getDate() + 1);
  nextMidnight.setHours(0, 0, 0, 0);
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  log(`⏰ Next package update scheduled at midnight (in ${Math.round(msUntilMidnight / 60000)}m)`);

  setTimeout(() => {
    runPackageUpdate();
    // After first run, repeat every 24h
    setInterval(runPackageUpdate, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

scheduleMidnightUpdate();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatUptime(seconds) {
  if (!seconds) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function getUptimeSeconds() {
  if (!state.joinTime) return null;
  return Math.floor((Date.now() - state.joinTime.getTime()) / 1000);
}

function getFullStatus() {
  const uptime = getUptimeSeconds();
  const bot = state.bot;
  let liveStats = null;

  if (state.connected && bot) {
    try {
      liveStats = {
        health: bot.health ?? null,
        food: bot.food ?? null,
        position: bot.entity?.position
          ? {
              x: parseFloat(bot.entity.position.x.toFixed(2)),
              y: parseFloat(bot.entity.position.y.toFixed(2)),
              z: parseFloat(bot.entity.position.z.toFixed(2)),
            }
          : null,
        dimension: bot.game?.dimension ?? null,
        ping: bot._client?.latency ?? null,
        gameMode: bot.game?.gameMode ?? null,
      };
    } catch (_) {}
  }

  return {
    service: 'Dertorrap Anti AFK Bot',
    timestamp: new Date().toISOString(),
    setup: {
      ip: state.ip,
      port: state.port,
      username: state.botUsername,
      version: state.mcVersion || 'auto-detect',
      auth: state.mcAuth,
    },
    connection: {
      connected: state.connected,
      autoReconnect: state.autoReconnect,
      uptimeSeconds: uptime,
      uptimeFormatted: uptime ? formatUptime(uptime) : null,
      joinTime: state.joinTime ? state.joinTime.toISOString() : null,
      lastError: state.lastError,
      disconnectReason: state.disconnectReason
        ? String(state.disconnectReason).slice(0, 200)
        : null,
    },
    actions: {
      jump: !!state.jumpInterval,
      move: !!state.moveInterval,
      sneak: state.sneakActive,
    },
    liveStats,
    recentLogs: state.logs.slice(-10),
  };
}

// ─── JSON Response Helpers ────────────────────────────────────────────────────
function jsonOk(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ success: true, ...data }, null, 2));
}

function jsonError(res, code, message, extra = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ success: false, error: message, ...extra }, null, 2));
}

// ─── Action Functions ─────────────────────────────────────────────────────────
function clearAllActions() {
  if (state.jumpInterval) { clearInterval(state.jumpInterval); state.jumpInterval = null; }
  if (state.moveInterval) { clearInterval(state.moveInterval); state.moveInterval = null; }
  if (state.bot && state.sneakActive) {
    try { state.bot.setControlState('sneak', false); } catch (_) {}
    state.sneakActive = false;
  }
}

function startAutoJump() {
  if (!state.bot || !state.connected) return false;
  if (state.sneakActive) {
    try { state.bot.setControlState('sneak', false); } catch (_) {}
    state.sneakActive = false;
  }
  if (state.jumpInterval) clearInterval(state.jumpInterval);
  state.jumpInterval = setInterval(() => {
    if (state.bot && state.connected) {
      try {
        state.bot.setControlState('jump', true);
        setTimeout(() => { if (state.bot) state.bot.setControlState('jump', false); }, 200);
      } catch (_) {}
    }
  }, 3000);
  log('Auto-jump started');
  return true;
}

function startAutoMove() {
  if (!state.bot || !state.connected) return false;
  const directions = ['forward', 'back', 'left', 'right'];
  let currentDir = null;
  if (state.moveInterval) clearInterval(state.moveInterval);
  state.moveInterval = setInterval(() => {
    if (!state.bot || !state.connected) return;
    try {
      if (currentDir) state.bot.setControlState(currentDir, false);
      currentDir = directions[Math.floor(Math.random() * directions.length)];
      state.bot.setControlState(currentDir, true);
    } catch (_) {}
  }, 1000);
  log('Auto-move started');
  return true;
}

function startSneak() {
  if (!state.bot || !state.connected) return false;
  if (state.jumpInterval) { clearInterval(state.jumpInterval); state.jumpInterval = null; }
  try {
    state.bot.setControlState('sneak', true);
    state.sneakActive = true;
  } catch (_) { return false; }
  log('Sneak started');
  return true;
}

// ─── Bot Creation ─────────────────────────────────────────────────────────────
function createBot() {
  if (state.bot) {
    clearAllActions();
    state.bot.removeAllListeners();
    try { state.bot.quit(); } catch (_) {}
    state.bot = null;
    state.connected = false;
  }

  log(`Connecting to ${state.ip}:${state.port} as ${state.botUsername}`);

  try {
    state.bot = mineflayer.createBot({
      host: state.ip,
      port: state.port,
      username: state.botUsername,
      version: state.mcVersion || false,
      auth: state.mcAuth,
    });
  } catch (err) {
    state.lastError = err.message;
    log(`Failed to create bot: ${err.message}`);
    return false;
  }

  state.bot.once('spawn', () => {
    state.connected = true;
    state.joinTime = new Date();
    state.disconnectReason = null;
    state.lastError = null;
    log(`Bot spawned on ${state.ip}:${state.port}`);
  });

  state.bot.on('error', (err) => {
    state.lastError = err.message;
    log(`Bot error: ${err.message}`);
  });

  state.bot.on('kicked', (reason) => {
    const wasConnected = state.connected;
    state.connected = false;
    state.disconnectReason = reason;
    clearAllActions();
    log(`Bot kicked: ${JSON.stringify(reason)}`);
    if (wasConnected) scheduleReconnect();
  });

  state.bot.on('end', (reason) => {
    if (!state.connected) return;
    state.connected = false;
    clearAllActions();
    log(`Bot disconnected: ${reason}`);
    scheduleReconnect();
  });

  state.bot.on('death', () => {
    log('Bot died — respawning');
    try { state.bot.respawn(); } catch (_) {}
  });

  return true;
}

function scheduleReconnect() {
  if (!state.autoReconnect) return;
  if (state.reconnectTimer) return;
  log('Scheduling reconnect in 15s...');
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.autoReconnect) {
      log('Auto-reconnecting...');
      createBot();
    }
  }, 15000);
}

// ─── HTML Dashboard ───────────────────────────────────────────────────────────
function renderDashboard() {
  const s = getFullStatus();
  const live = s.liveStats;
  const conn = s.connection;
  const actions = s.actions;
  const setup = s.setup;

  const connColor = conn.connected ? '#22c55e' : '#ef4444';
  const connLabel = conn.connected ? '🟢 Connected' : '🔴 Disconnected';

  const statCard = (label, value, color = '#e2e8f0') => `
    <div class="card">
      <div class="card-label">${label}</div>
      <div class="card-value" style="color:${color}">${value ?? '<span class="na">N/A</span>'}</div>
    </div>`;

  const badge = (on, labelOn, labelOff) =>
    `<span class="badge ${on ? 'badge-on' : 'badge-off'}">${on ? labelOn : labelOff}</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Dertorrap Anti AFK Bot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      padding: 24px 16px;
    }
    .header {
      text-align: center;
      margin-bottom: 32px;
    }
    .header h1 {
      font-size: 1.8rem;
      font-weight: 800;
      background: linear-gradient(135deg, #60a5fa, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: 1px;
    }
    .header p {
      color: #64748b;
      font-size: 0.85rem;
      margin-top: 6px;
    }
    .status-banner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 16px 24px;
      margin-bottom: 24px;
      font-size: 1.1rem;
      font-weight: 600;
    }
    .dot {
      width: 12px; height: 12px;
      border-radius: 50%;
      background: ${connColor};
      box-shadow: 0 0 8px ${connColor};
      animation: ${conn.connected ? 'pulse 2s infinite' : 'none'};
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .section { margin-bottom: 24px; }
    .section-title {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: #60a5fa;
      margin-bottom: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 14px 16px;
    }
    .card-label {
      font-size: 0.72rem;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }
    .card-value {
      font-size: 1rem;
      font-weight: 600;
      word-break: break-all;
    }
    .na { color: #475569; font-style: italic; }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 600;
    }
    .badge-on { background: #14532d; color: #86efac; border: 1px solid #22c55e; }
    .badge-off { background: #1c1917; color: #78716c; border: 1px solid #44403c; }
    .actions-grid {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .log-box {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 14px 16px;
      font-family: 'Courier New', monospace;
      font-size: 0.78rem;
      color: #94a3b8;
      max-height: 220px;
      overflow-y: auto;
    }
    .log-entry { padding: 3px 0; border-bottom: 1px solid #1e293b; }
    .log-time { color: #475569; margin-right: 8px; }
    .endpoints-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
    }
    .endpoint {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 10px 14px;
      font-family: monospace;
      font-size: 0.82rem;
    }
    .endpoint .method { color: #60a5fa; font-weight: 700; margin-right: 6px; }
    .endpoint .path { color: #a78bfa; }
    .endpoint .desc { color: #64748b; font-size: 0.72rem; margin-top: 4px; font-family: sans-serif; }
    .refresh-bar {
      text-align: center;
      color: #475569;
      font-size: 0.78rem;
      margin-top: 28px;
    }
    .timestamp { color: #475569; font-size: 0.72rem; }
  </style>
</head>
<body>

<div class="header">
  <h1>🛡️ DERTORRAP ANTI AFK BOT</h1>
  <p class="timestamp">Last updated: ${s.timestamp}</p>
</div>

<div class="status-banner">
  <div class="dot"></div>
  <span style="color:${connColor}">${connLabel}</span>
  ${conn.connected ? `<span style="color:#64748b;font-size:0.85rem">· Uptime: ${conn.uptimeFormatted}</span>` : ''}
</div>

<!-- Setup -->
<div class="section">
  <div class="section-title">⚙️ Setup</div>
  <div class="grid">
    ${statCard('IP Address', setup.ip || '—', '#60a5fa')}
    ${statCard('Port', setup.port, '#60a5fa')}
    ${statCard('Username', setup.username, '#a78bfa')}
    ${statCard('MC Version', setup.version, '#a78bfa')}
    ${statCard('Auth Mode', setup.auth, '#94a3b8')}
  </div>
</div>

<!-- Connection -->
<div class="section">
  <div class="section-title">📡 Connection</div>
  <div class="grid">
    ${statCard('Status', connLabel, connColor)}
    ${statCard('Auto-Reconnect', conn.autoReconnect ? '✅ Enabled' : '❌ Disabled')}
    ${statCard('Uptime', conn.uptimeFormatted || '—', '#22c55e')}
    ${statCard('Join Time', conn.joinTime ? conn.joinTime.replace('T', ' ').split('.')[0] : '—')}
    ${conn.lastError ? statCard('Last Error', conn.lastError.slice(0, 40), '#f87171') : ''}
    ${conn.disconnectReason ? statCard('Disconnect Reason', String(conn.disconnectReason).slice(0, 40), '#fb923c') : ''}
  </div>
</div>

<!-- Live Stats -->
${live ? `
<div class="section">
  <div class="section-title">⚡ Live Stats</div>
  <div class="grid">
    ${statCard('❤️ Health', live.health != null ? `${live.health.toFixed(1)} / 20` : null, live.health < 5 ? '#ef4444' : '#22c55e')}
    ${statCard('🍖 Food', live.food != null ? `${live.food} / 20` : null)}
    ${statCard('🌍 Dimension', live.dimension)}
    ${statCard('🏓 Ping', live.ping != null ? `${live.ping}ms` : null)}
    ${statCard('🎮 Game Mode', live.gameMode)}
    ${live.position ? statCard('📍 Position', `x:${live.position.x} y:${live.position.y} z:${live.position.z}`, '#facc15') : ''}
  </div>
</div>` : ''}

<!-- Actions -->
<div class="section">
  <div class="section-title">🕹️ Active Actions</div>
  <div class="actions-grid">
    ${badge(actions.jump, '🐸 Auto-Jump ON', '🐸 Auto-Jump OFF')}
    ${badge(actions.move, '🚶 Auto-Move ON', '🚶 Auto-Move OFF')}
    ${badge(actions.sneak, '🦆 Sneak ON', '🦆 Sneak OFF')}
  </div>
</div>

<!-- Endpoints -->
<div class="section">
  <div class="section-title">🔗 API Endpoints</div>
  <div class="endpoints-grid">
    <div class="endpoint"><span class="method">GET</span><span class="path">/health</span><div class="desc">This dashboard + JSON status</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/status</span><div class="desc">Full JSON status</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/start</span><div class="desc">Connect bot to server</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/stop</span><div class="desc">Disconnect bot</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/jump</span><div class="desc">Start auto-jump (3s)</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/move</span><div class="desc">Start auto-move (1s)</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/sneak</span><div class="desc">Toggle sneak mode</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/stopaction</span><div class="desc">Stop all actions</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/ip?value=x</span><div class="desc">Set server IP</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/port?value=x</span><div class="desc">Set server port</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/rename?value=x</span><div class="desc">Rename bot username</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/version?value=x</span><div class="desc">Set MC version</div></div>
  </div>
</div>

<!-- Logs -->
<div class="section">
  <div class="section-title">📋 Recent Logs</div>
  <div class="log-box">
    ${s.recentLogs.length === 0 ? '<div class="log-entry">No logs yet.</div>' :
      [...s.recentLogs].reverse().map(l =>
        `<div class="log-entry"><span class="log-time">${l.time.replace('T',' ').split('.')[0]}</span>${l.msg}</div>`
      ).join('')}
  </div>
</div>

<div class="refresh-bar">
  🔄 <a href="/health" style="color:#475569">Refresh</a> &nbsp;·&nbsp; Auto-refreshes every 15 seconds
</div>

<script>setTimeout(() => location.reload(), 15000);</script>
</body>
</html>`;
}

// ─── HTTP Router ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname.replace(/\/$/, '') || '/';
  const query = parsed.query;

  // Optional API key check (skip for /health)
  if (API_KEY && path !== '/health' && query.key !== API_KEY) {
    return jsonError(res, 401, 'Unauthorized. Pass ?key=YOUR_API_KEY');
  }

  // ── GET /health ──────────────────────────────────────────────────────────
  if (path === '/health' || path === '/') {
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(renderDashboard());
    }
    // If hit via API / UptimeRobot
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ success: true, ...getFullStatus() }, null, 2));
  }

  // ── GET /status ──────────────────────────────────────────────────────────
  if (path === '/status') {
    return jsonOk(res, getFullStatus());
  }

  // ── GET /ip?value=x ──────────────────────────────────────────────────────
  if (path === '/ip') {
    const value = query.value;
    if (!value) return jsonError(res, 400, 'Missing ?value=<ip-address>');
    state.ip = value;
    log(`IP set to ${state.ip}`);
    return jsonOk(res, { message: `IP set to ${state.ip}`, ip: state.ip, port: state.port, readyToStart: state.portSet });
  }

  // ── GET /port?value=x ────────────────────────────────────────────────────
  if (path === '/port') {
    const p = parseInt(query.value);
    if (!query.value || isNaN(p) || p < 1 || p > 65535)
      return jsonError(res, 400, 'Missing or invalid ?value=<1-65535>');
    state.port = p;
    state.portSet = true;
    log(`Port set to ${state.port}`);
    return jsonOk(res, { message: `Port set to ${state.port}`, ip: state.ip, port: state.port, readyToStart: !!state.ip });
  }

  // ── GET /rename?value=x ──────────────────────────────────────────────────
  if (path === '/rename') {
    const name = query.value;
    if (!name) return jsonError(res, 400, 'Missing ?value=<username>');
    if (name.length < 3 || name.length > 16) return jsonError(res, 400, 'Username must be 3–16 characters');
    if (!/^[a-zA-Z0-9_]+$/.test(name)) return jsonError(res, 400, 'Username can only contain a-z, 0-9, underscore');
    const old = state.botUsername;
    state.botUsername = name;
    log(`Bot renamed from ${old} to ${name}`);
    return jsonOk(res, { message: `Bot renamed`, oldUsername: old, newUsername: name, note: state.connected ? 'Use /stop then /start to apply' : 'Will apply on next /start' });
  }

  // ── GET /version?value=x ─────────────────────────────────────────────────
  if (path === '/version') {
    const v = query.value;
    if (!v) return jsonError(res, 400, 'Missing ?value=<version> e.g. 1.20.1 or auto');
    if (v === 'auto') {
      state.mcVersion = null;
      log('MC version reset to auto-detect');
      return jsonOk(res, { message: 'Version reset to auto-detect', version: 'auto-detect' });
    }
    if (!/^\d+\.\d+(\.\d+)?$/.test(v)) return jsonError(res, 400, 'Invalid version format. Use e.g. 1.20.1');
    state.mcVersion = v;
    log(`MC version set to ${v}`);
    return jsonOk(res, { message: `Version set to ${v}`, version: v });
  }

  // ── GET /start ───────────────────────────────────────────────────────────
  if (path === '/start') {
    if (!state.ip && !state.portSet) return jsonError(res, 400, 'Both IP and Port are not set', { hint: 'Hit /ip?value=x and /port?value=x first' });
    if (!state.ip) return jsonError(res, 400, 'IP not set', { hint: `Hit /ip?value=<address>`, portAlreadySet: state.port });
    if (!state.portSet) return jsonError(res, 400, 'Port not set', { hint: 'Hit /port?value=25565', ipAlreadySet: state.ip });
    if (state.connected) return jsonError(res, 409, 'Bot is already connected', { server: `${state.ip}:${state.port}`, hint: 'Hit /stop first' });

    state.autoReconnect = true;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    const ok = createBot();
    if (!ok) return jsonError(res, 500, 'Failed to initialize bot', { lastError: state.lastError });
    return jsonOk(res, { message: `Connecting to ${state.ip}:${state.port}`, username: state.botUsername, autoReconnect: true, note: 'Check /status for connection result' });
  }

  // ── GET /stop ────────────────────────────────────────────────────────────
  if (path === '/stop') {
    if (!state.bot && !state.connected) return jsonError(res, 400, 'Bot is not running', { hint: 'Use /start to connect first' });
    state.autoReconnect = false;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    clearAllActions();
    if (state.bot) {
      try { state.bot.quit('Stopped via API'); } catch (_) {}
      state.bot = null;
    }
    state.connected = false;
    log('Bot stopped via API');
    return jsonOk(res, { message: 'Bot stopped', autoReconnect: false });
  }

  // ── GET /jump ────────────────────────────────────────────────────────────
  if (path === '/jump') {
    if (!state.connected) return jsonError(res, 400, 'Bot is not connected', { hint: 'Use /start first' });
    if (state.sneakActive) {
      try { state.bot.setControlState('sneak', false); } catch (_) {}
      state.sneakActive = false;
    }
    const ok = startAutoJump();
    if (!ok) return jsonError(res, 500, 'Failed to start auto-jump');
    return jsonOk(res, { message: 'Auto-jump started', intervalSeconds: 3, sneakStopped: true });
  }

  // ── GET /move ────────────────────────────────────────────────────────────
  if (path === '/move') {
    if (!state.connected) return jsonError(res, 400, 'Bot is not connected', { hint: 'Use /start first' });
    const ok = startAutoMove();
    if (!ok) return jsonError(res, 500, 'Failed to start auto-move');
    return jsonOk(res, { message: 'Auto-move started', intervalSeconds: 1, directions: ['forward', 'back', 'left', 'right'] });
  }

  // ── GET /sneak ───────────────────────────────────────────────────────────
  if (path === '/sneak') {
    if (!state.connected) return jsonError(res, 400, 'Bot is not connected', { hint: 'Use /start first' });
    const ok = startSneak();
    if (!ok) return jsonError(res, 500, 'Failed to start sneak');
    return jsonOk(res, { message: 'Sneak mode activated', jumpStopped: true });
  }

  // ── GET /stopaction ──────────────────────────────────────────────────────
  if (path === '/stopaction') {
    clearAllActions();
    log('All actions stopped via API');
    return jsonOk(res, { message: 'All actions stopped', jump: false, move: false, sneak: false });
  }

  // ── 404 ──────────────────────────────────────────────────────────────────
  return jsonError(res, 404, `Unknown endpoint: ${path}`, {
    availableEndpoints: [
      '/health', '/status', '/start', '/stop',
      '/jump', '/move', '/sneak', '/stopaction',
      '/ip?value=x', '/port?value=x', '/rename?value=x', '/version?value=x'
    ]
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('🛡️  DERTORRAP ANTI AFK BOT');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/health`);
  console.log(`📡 All endpoints: http://localhost:${PORT}/status`);
  if (API_KEY) console.log(`🔒 API key protection enabled`);
  console.log('');
});

process.on('uncaughtException', (err) => { log(`Uncaught: ${err.message}`); });
process.on('unhandledRejection', (reason) => { log(`Rejection: ${reason}`); });
