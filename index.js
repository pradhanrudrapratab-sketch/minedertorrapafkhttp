const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock } = goals;
const http = require('http');
const url = require('url');
const net = require('net');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;

// ─── Hostile Mob List ──────────────────────────────────────────────────────────
const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch',
  'blaze', 'ghast', 'slime', 'magma_cube', 'enderman', 'endermite',
  'silverfish', 'phantom', 'drowned', 'husk', 'stray', 'wither_skeleton',
  'pillager', 'vindicator', 'evoker', 'ravager', 'guardian', 'elder_guardian',
  'shulker', 'vex', 'zombie_villager', 'zombified_piglin', 'piglin_brute',
  'hoglin', 'zoglin', 'warden'
]);

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

  // ── NEW: Server ping & player count state ──────────────────────────────────
  serverOnline: false,
  serverPingTimer: null,           // polls every 15s when offline
  serverCheckTimer: null,          // polls every 60s when online with 2+ players
  lastServerPing: null,            // { online, playerCount, maxPlayers, version, latency, ts }
  pingPhase: 'idle',               // 'idle' | 'waiting_online' | 'monitoring'

  // ── NEW: Combat / survival state ───────────────────────────────────────────
  combatInterval: null,            // ticks mob scan & attack
  waterInterval: null,             // holds space when in water
  pathfindingActive: false,

  joinTime: null,
  disconnectReason: null,
  lastError: null,
  logs: [],
};

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(msg) {
  const entry = { time: new Date().toISOString(), msg };
  console.log(`[${entry.time}] ${msg}`);
  state.logs.push(entry);
  if (state.logs.length > 20) state.logs.shift();
}

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

// ─── Minecraft Server SLP Ping (raw TCP, zero extra deps) ─────────────────────
// Uses the modern 1.7+ Server List Ping handshake via net module.
// Returns { online: true, playerCount, maxPlayers, version, latency } or { online: false }
function pingMinecraftServer(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    let buf = Buffer.alloc(0);

    const finish = (result) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) {}
      resolve(result);
    };

    const socket = net.createConnection({ host, port });

    const timer = setTimeout(() => {
      finish({ online: false, error: 'timeout' });
    }, timeoutMs);

    socket.once('connect', () => {
      // ── Handshake packet (0x00) ──
      // Fields: packet id, protocol version (VarInt 47 = 1.8, works for all modern),
      //         server address, port (uint16), next state (1 = status)
      const hostBuf = Buffer.from(host, 'utf8');

      function writeVarInt(val) {
        const bytes = [];
        do {
          let b = val & 0x7f;
          val >>>= 7;
          if (val !== 0) b |= 0x80;
          bytes.push(b);
        } while (val !== 0);
        return Buffer.from(bytes);
      }

      const handshakePayload = Buffer.concat([
        writeVarInt(0x00),           // packet id
        writeVarInt(47),             // protocol version (1.8 — server accepts any)
        writeVarInt(hostBuf.length), // host string length
        hostBuf,                     // host
        Buffer.from([((port >> 8) & 0xff), (port & 0xff)]), // port uint16 BE
        writeVarInt(1),              // next state: status
      ]);
      const handshakeLenBuf = writeVarInt(handshakePayload.length);

      // ── Status Request packet (0x00, no payload) ──
      const statusRequest = Buffer.from([0x01, 0x00]);

      socket.write(Buffer.concat([handshakeLenBuf, handshakePayload, statusRequest]));
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        // Read VarInt length prefix
        let offset = 0;
        let packetLen = 0, shift = 0, b;
        do {
          if (offset >= buf.length) return; // need more data
          b = buf[offset++];
          packetLen |= (b & 0x7f) << shift;
          shift += 7;
        } while (b & 0x80);

        if (buf.length < offset + packetLen) return; // incomplete

        // Read packet id VarInt
        let packetId = 0; shift = 0;
        do {
          b = buf[offset++];
          packetId |= (b & 0x7f) << shift;
          shift += 7;
        } while (b & 0x80);

        if (packetId !== 0x00) return finish({ online: false, error: 'bad_packet_id' });

        // Read JSON string length VarInt
        let strLen = 0; shift = 0;
        do {
          b = buf[offset++];
          strLen |= (b & 0x7f) << shift;
          shift += 7;
        } while (b & 0x80);

        const jsonStr = buf.slice(offset, offset + strLen).toString('utf8');
        const data = JSON.parse(jsonStr);

        clearTimeout(timer);
        finish({
          online: true,
          playerCount: data.players?.online ?? 0,
          maxPlayers: data.players?.max ?? 0,
          version: data.version?.name ?? 'unknown',
          motd: typeof data.description === 'string'
            ? data.description
            : (data.description?.text ?? ''),
          latency: Date.now() - start,
        });
      } catch (_) {
        // Buffer incomplete or parse error — wait for more data
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      finish({ online: false, error: err.message });
    });

    socket.on('close', () => {
      clearTimeout(timer);
      if (!done) finish({ online: false, error: 'connection_closed' });
    });
  });
}

// ─── Server Ping Logic ────────────────────────────────────────────────────────

function stopServerPingTimers() {
  if (state.serverPingTimer) { clearInterval(state.serverPingTimer); state.serverPingTimer = null; }
  if (state.serverCheckTimer) { clearInterval(state.serverCheckTimer); state.serverCheckTimer = null; }
}

// Called once after /start — keeps checking until server is online, then hands over to monitorServer()
async function waitForServerOnline() {
  if (!state.ip || !state.autoReconnect) return;

  stopServerPingTimers();
  state.pingPhase = 'waiting_online';
  log(`Pinging ${state.ip}:${state.port} every 15s until server is online...`);

  const doPing = async () => {
    if (!state.autoReconnect) return stopServerPingTimers();
    const result = await pingMinecraftServer(state.ip, state.port);
    state.lastServerPing = { ...result, ts: new Date().toISOString() };

    if (result.online) {
      log(`Server online! Players: ${result.playerCount}/${result.maxPlayers}, version: ${result.version}, ping: ${result.latency}ms`);
      stopServerPingTimers();
      handleServerOnlineDecision(result.playerCount);
    } else {
      log(`Server offline (${result.error || 'no response'}) — retrying in 15s`);
    }
  };

  await doPing(); // immediate first check
  if (state.pingPhase === 'waiting_online') {
    state.serverPingTimer = setInterval(doPing, 15000);
  }
}

// Called after bot connects — monitor every 60s. If players > 1 → stop bot, if ≤ 1 → keep running
function startServerMonitoring() {
  if (!state.ip) return;
  stopServerPingTimers();
  state.pingPhase = 'monitoring';
  log('Server monitoring started (60s interval)');

  state.serverCheckTimer = setInterval(async () => {
    if (!state.autoReconnect) return stopServerPingTimers();
    const result = await pingMinecraftServer(state.ip, state.port);
    state.lastServerPing = { ...result, ts: new Date().toISOString() };

    if (!result.online) {
      log('Server went offline during monitoring');
      stopBot();
      waitForServerOnline();
      return;
    }

    log(`Monitor check: ${result.playerCount}/${result.maxPlayers} players online`);
    handleServerOnlineDecision(result.playerCount);
  }, 60000);
}

// Core decision: 0-1 players → start/keep bot; 2+ players → stop bot
async function handleServerOnlineDecision(playerCount) {
  state.serverOnline = true;

  if (playerCount <= 1) {
    // ≤ 1 player (bot itself maybe) → make sure bot is running
    if (!state.connected && !state.reconnectTimer) {
      log(`Player count ${playerCount} ≤ 1 → starting bot`);
      createBot();
    } else {
      log(`Player count ${playerCount} ≤ 1 → bot already running`);
    }
  } else {
    // 2+ players → stop bot
    if (state.connected || state.bot) {
      log(`Player count ${playerCount} ≥ 2 → stopping bot to avoid suspicion`);
      stopBot();
    } else {
      log(`Player count ${playerCount} ≥ 2 → bot already stopped`);
    }
    // Switch to monitoring phase to keep checking
    if (state.pingPhase !== 'monitoring') startServerMonitoring();
  }
}

function stopBot() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  stopAllBotSystems();
  if (state.bot) {
    try { state.bot.quit('Stopped by server monitor'); } catch (_) {}
    state.bot = null;
  }
  state.connected = false;
  state.autoReconnect = false; // prevent reconnect loop; waitForServerOnline handles restarts
}

// ─── Combat & Survival Systems ────────────────────────────────────────────────

function startCombatSystem() {
  if (state.combatInterval) return;
  state.combatInterval = setInterval(() => {
    if (!state.bot || !state.connected) return;
    try {
      scanAndAttackHostile();
    } catch (err) {
      log(`Combat scan error: ${err.message}`);
    }
  }, 1000); // scan every 1s
  log('Combat system started');
}

function stopCombatSystem() {
  if (state.combatInterval) { clearInterval(state.combatInterval); state.combatInterval = null; }
}

function scanAndAttackHostile() {
  const bot = state.bot;
  if (!bot || !bot.entity) return;

  // Find nearest hostile mob within 4 blocks (sword range is ~3.5)
  const hostile = bot.nearestEntity((entity) => {
    if (!entity || !entity.name) return false;
    const mobName = entity.name.toLowerCase().replace(/^minecraft:/, '');
    if (!HOSTILE_MOBS.has(mobName)) return false;
    const dist = bot.entity.position.distanceTo(entity.position);
    return dist <= 4.5;
  });

  if (!hostile) return;

  const dist = bot.entity.position.distanceTo(hostile.position);
  log(`Hostile mob nearby: ${hostile.name} at ${dist.toFixed(1)} blocks — attacking`);

  try {
    // Look at mob first, then attack
    bot.lookAt(hostile.position.offset(0, hostile.height / 2, 0));
    bot.attack(hostile);
  } catch (err) {
    // mob despawned between scan and attack — safe to ignore
  }
}

// ─── Water Survival System ────────────────────────────────────────────────────

function startWaterSurvival() {
  if (state.waterInterval) return;
  state.waterInterval = setInterval(() => {
    if (!state.bot || !state.connected || !state.bot.entity) return;
    try {
      const inWater = state.bot.entity.isInWater;
      if (inWater) {
        state.bot.setControlState('jump', true); // hold space = swim up
      } else {
        // Only release if we were holding jump for water (not for auto-jump)
        if (!state.jumpInterval) {
          state.bot.setControlState('jump', false);
        }
      }
    } catch (_) {}
  }, 500); // check every 500ms
  log('Water survival system started');
}

function stopWaterSurvival() {
  if (state.waterInterval) { clearInterval(state.waterInterval); state.waterInterval = null; }
}

// ─── Pathfinder Move ──────────────────────────────────────────────────────────
// Replaces the old random move — uses pathfinder to walk to a random nearby safe block
// Falls back to raw controls if pathfinder has no path

function startAutoMove() {
  if (!state.bot || !state.connected) return false;

  // Stop old move interval if any
  if (state.moveInterval) { clearInterval(state.moveInterval); state.moveInterval = null; }

  state.pathfindingActive = true;
  log('Auto-move (pathfinding) started');

  // Kick off first move immediately, then repeat every 5s
  doPathfinderMove();
  state.moveInterval = setInterval(doPathfinderMove, 5000);
  return true;
}

function doPathfinderMove() {
  const bot = state.bot;
  if (!bot || !state.connected || !bot.entity) return;

  try {
    const pos = bot.entity.position;
    const mcData = require('minecraft-data')(bot.version);
    const movements = new Movements(bot, mcData);
    movements.canDig = false;      // don't dig blocks
    movements.allow1by1towers = false;
    bot.pathfinder.setMovements(movements);

    // Pick a random target 3-8 blocks away (X/Z only)
    const angle = Math.random() * Math.PI * 2;
    const dist = 3 + Math.floor(Math.random() * 5);
    const tx = Math.floor(pos.x + Math.cos(angle) * dist);
    const tz = Math.floor(pos.z + Math.sin(angle) * dist);
    const ty = Math.floor(pos.y);

    // Check if target block is walkable (solid ground under, air at feet & head)
    const targetGround = bot.blockAt(bot.entity.position.offset(
      tx - Math.floor(pos.x),
      -1,
      tz - Math.floor(pos.z)
    ));

    if (!targetGround || targetGround.name === 'air' || targetGround.name === 'water') {
      log('No walkable target nearby — scanning for safe spot');
      findAndMoveSafeSpot(bot, pos, movements);
      return;
    }

    bot.pathfinder.setGoal(new GoalNear(tx, ty, tz, 1));
    log(`Pathfinding to (${tx}, ${ty}, ${tz})`);
  } catch (err) {
    log(`Pathfinder error: ${err.message} — falling back to raw movement`);
    fallbackMove();
  }
}

function findAndMoveSafeSpot(bot, pos, movements) {
  // Spiral scan up to 10 blocks radius for a safe block
  for (let r = 1; r <= 10; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; // only perimeter
        try {
          const tx = Math.floor(pos.x) + dx;
          const tz = Math.floor(pos.z) + dz;
          const ty = Math.floor(pos.y);
          const ground = bot.blockAt({ x: tx, y: ty - 1, z: tz });
          const feet = bot.blockAt({ x: tx, y: ty, z: tz });
          const head = bot.blockAt({ x: tx, y: ty + 1, z: tz });
          if (
            ground && ground.name !== 'air' && ground.name !== 'water' &&
            feet && feet.name === 'air' &&
            head && head.name === 'air'
          ) {
            bot.pathfinder.setGoal(new GoalNear(tx, ty, tz, 1));
            log(`Safe spot found at (${tx}, ${ty}, ${tz})`);
            return;
          }
        } catch (_) {}
      }
    }
  }
  log('No safe spot found within 10 blocks — staying put');
  fallbackMove();
}

function fallbackMove() {
  // Raw movement fallback — original random direction logic
  if (!state.bot || !state.connected) return;
  const directions = ['forward', 'back', 'left', 'right'];
  const dir = directions[Math.floor(Math.random() * directions.length)];
  try {
    state.bot.setControlState(dir, true);
    setTimeout(() => {
      if (state.bot) state.bot.setControlState(dir, false);
    }, 800);
  } catch (_) {}
}

// ─── Action Functions ─────────────────────────────────────────────────────────

function clearAllActions() {
  if (state.jumpInterval) { clearInterval(state.jumpInterval); state.jumpInterval = null; }
  if (state.moveInterval) {
    clearInterval(state.moveInterval);
    state.moveInterval = null;
    state.pathfindingActive = false;
    // Stop pathfinder goal if running
    if (state.bot) {
      try { state.bot.pathfinder.setGoal(null); } catch (_) {}
    }
  }
  if (state.bot && state.sneakActive) {
    try { state.bot.setControlState('sneak', false); } catch (_) {}
    state.sneakActive = false;
  }
}

function stopAllBotSystems() {
  clearAllActions();
  stopCombatSystem();
  stopWaterSurvival();
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
    stopAllBotSystems();
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

  // Load pathfinder plugin
  try {
    state.bot.loadPlugin(pathfinder);
  } catch (err) {
    log(`Pathfinder load error: ${err.message}`);
  }

  state.bot.once('spawn', () => {
    state.connected = true;
    state.joinTime = new Date();
    state.disconnectReason = null;
    state.lastError = null;
    log(`Bot spawned on ${state.ip}:${state.port}`);

    // Start persistent systems on spawn
    startCombatSystem();
    startWaterSurvival();
    startServerMonitoring(); // switch to 60s monitoring mode
  });

  state.bot.on('error', (err) => {
    state.lastError = err.message;
    log(`Bot error: ${err.message}`);
  });

  state.bot.on('kicked', (reason) => {
    const wasConnected = state.connected;
    state.connected = false;
    state.disconnectReason = reason;
    stopAllBotSystems();
    log(`Bot kicked: ${JSON.stringify(reason)}`);
    if (wasConnected && state.autoReconnect) scheduleReconnect();
  });

  state.bot.on('end', (reason) => {
    if (!state.connected) return;
    state.connected = false;
    stopAllBotSystems();
    log(`Bot disconnected: ${reason}`);
    if (state.autoReconnect) scheduleReconnect();
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

// ─── Full Status ──────────────────────────────────────────────────────────────
function getFullStatus() {
  const uptime = getUptimeSeconds();
  const bot = state.bot;
  let liveStats = null;

  if (state.connected && bot) {
    try {
      liveStats = {
        health: bot.health ?? null,
        food: bot.food ?? null,
        inWater: bot.entity?.isInWater ?? false,
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
    serverPing: {
      phase: state.pingPhase,
      lastPing: state.lastServerPing,
    },
    actions: {
      jump: !!state.jumpInterval,
      move: !!state.moveInterval,
      sneak: state.sneakActive,
      pathfinding: state.pathfindingActive,
      combat: !!state.combatInterval,
      waterSurvival: !!state.waterInterval,
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

// ─── HTML Dashboard ───────────────────────────────────────────────────────────
function renderDashboard() {
  const s = getFullStatus();
  const live = s.liveStats;
  const conn = s.connection;
  const actions = s.actions;
  const setup = s.setup;
  const ping = s.serverPing;

  const connColor = conn.connected ? '#22c55e' : '#ef4444';
  const connLabel = conn.connected ? '🟢 Connected' : '🔴 Disconnected';

  const phaseLabel = {
    idle: '⏸️ Idle',
    waiting_online: '⏳ Waiting for Server...',
    monitoring: '📡 Monitoring (60s)',
  }[ping.phase] || ping.phase;

  const statCard = (label, value, color = '#e2e8f0') => `
    <div class="card">
      <div class="card-label">${label}</div>
      <div class="card-value" style="color:${color}">${value ?? '<span class="na">N/A</span>'}</div>
    </div>`;

  const badge = (on, labelOn, labelOff) =>
    `<span class="badge ${on ? 'badge-on' : 'badge-off'}">${on ? labelOn : labelOff}</span>`;

  const pingCard = ping.lastPing
    ? (ping.lastPing.online
      ? `<div class="ping-card online">
          <span class="ping-status">🟢 Online</span>
          <span class="ping-detail">👥 ${ping.lastPing.playerCount}/${ping.lastPing.maxPlayers} players</span>
          <span class="ping-detail">🏓 ${ping.lastPing.latency}ms</span>
          <span class="ping-detail">🗂️ ${ping.lastPing.version}</span>
        </div>`
      : `<div class="ping-card offline">
          <span class="ping-status">🔴 Server Offline</span>
          <span class="ping-detail">${ping.lastPing.error || 'No response'}</span>
        </div>`)
    : `<div class="ping-card idle"><span class="ping-status">⏸️ Not pinged yet</span></div>`;

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
    .header { text-align: center; margin-bottom: 32px; }
    .header h1 {
      font-size: 1.8rem; font-weight: 800;
      background: linear-gradient(135deg, #60a5fa, #a78bfa);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      letter-spacing: 1px;
    }
    .header p { color: #64748b; font-size: 0.85rem; margin-top: 6px; }
    .status-banner {
      display: flex; align-items: center; justify-content: center;
      gap: 12px; background: #1e293b; border: 1px solid #334155;
      border-radius: 12px; padding: 16px 24px; margin-bottom: 24px;
      font-size: 1.1rem; font-weight: 600;
    }
    .dot {
      width: 12px; height: 12px; border-radius: 50%;
      background: ${connColor}; box-shadow: 0 0 8px ${connColor};
      animation: ${conn.connected ? 'pulse 2s infinite' : 'none'};
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .section { margin-bottom: 24px; }
    .section-title {
      font-size: 0.75rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: 1.5px;
      color: #60a5fa; margin-bottom: 12px;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 14px 16px; }
    .card-label { font-size: 0.72rem; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
    .card-value { font-size: 1rem; font-weight: 600; word-break: break-all; }
    .na { color: #475569; font-style: italic; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
    .badge-on  { background: #14532d; color: #86efac; border: 1px solid #22c55e; }
    .badge-off { background: #1c1917; color: #78716c; border: 1px solid #44403c; }
    .actions-grid { display: flex; gap: 10px; flex-wrap: wrap; }
    .ping-card {
      border-radius: 10px; padding: 14px 18px;
      display: flex; gap: 16px; flex-wrap: wrap; align-items: center;
      border: 1px solid #334155;
    }
    .ping-card.online  { background: #052e16; border-color: #22c55e; }
    .ping-card.offline { background: #2d0a0a; border-color: #ef4444; }
    .ping-card.idle    { background: #1e293b; }
    .ping-status { font-weight: 700; font-size: 1rem; }
    .ping-detail { font-size: 0.85rem; color: #94a3b8; }
    .ping-phase { font-size: 0.78rem; color: #64748b; margin-top: 8px; }
    .log-box {
      background: #0f172a; border: 1px solid #334155; border-radius: 10px;
      padding: 14px 16px; font-family: 'Courier New', monospace;
      font-size: 0.78rem; color: #94a3b8; max-height: 220px; overflow-y: auto;
    }
    .log-entry { padding: 3px 0; border-bottom: 1px solid #1e293b; }
    .log-time { color: #475569; margin-right: 8px; }
    .endpoints-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
    .endpoint { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; font-family: monospace; font-size: 0.82rem; }
    .endpoint .method { color: #60a5fa; font-weight: 700; margin-right: 6px; }
    .endpoint .path { color: #a78bfa; }
    .endpoint .desc { color: #64748b; font-size: 0.72rem; margin-top: 4px; font-family: sans-serif; }
    .refresh-bar { text-align: center; color: #475569; font-size: 0.78rem; margin-top: 28px; }
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

<!-- Server Ping Status -->
<div class="section">
  <div class="section-title">🌐 Server Status</div>
  ${pingCard}
  <div class="ping-phase">Phase: ${phaseLabel}</div>
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
    ${statCard('🌊 In Water', live.inWater ? '💧 Yes' : '🏃 No', live.inWater ? '#38bdf8' : '#94a3b8')}
    ${statCard('🌍 Dimension', live.dimension)}
    ${statCard('🏓 Ping', live.ping != null ? `${live.ping}ms` : null)}
    ${statCard('🎮 Game Mode', live.gameMode)}
    ${live.position ? statCard('📍 Position', `x:${live.position.x} y:${live.position.y} z:${live.position.z}`, '#facc15') : ''}
  </div>
</div>` : ''}

<!-- Actions -->
<div class="section">
  <div class="section-title">🕹️ Active Systems</div>
  <div class="actions-grid">
    ${badge(actions.jump,          '🐸 Auto-Jump ON',     '🐸 Auto-Jump OFF')}
    ${badge(actions.move,          '🚶 Pathfinding ON',   '🚶 Pathfinding OFF')}
    ${badge(actions.sneak,         '🦆 Sneak ON',         '🦆 Sneak OFF')}
    ${badge(actions.combat,        '⚔️ Combat ON',        '⚔️ Combat OFF')}
    ${badge(actions.waterSurvival, '🌊 Water Guard ON',   '🌊 Water Guard OFF')}
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
    <div class="endpoint"><span class="method">GET</span><span class="path">/move</span><div class="desc">Pathfinding move</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/sneak</span><div class="desc">Toggle sneak mode</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/stopaction</span><div class="desc">Stop all actions</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/ip?value=x</span><div class="desc">Set server IP</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/port?value=x</span><div class="desc">Set server port</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/rename?value=x</span><div class="desc">Rename bot username</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/version?value=x</span><div class="desc">Set MC version</div></div>
    <div class="endpoint"><span class="method">GET</span><span class="path">/pingserver</span><div class="desc">Manual server ping</div></div>
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

  if (API_KEY && path !== '/health' && query.key !== API_KEY) {
    return jsonError(res, 401, 'Unauthorized. Pass ?key=YOUR_API_KEY');
  }

  // ── GET /health ────────────────────────────────────────────────────────────
  if (path === '/health' || path === '/') {
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(renderDashboard());
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ success: true, ...getFullStatus() }, null, 2));
  }

  // ── GET /status ────────────────────────────────────────────────────────────
  if (path === '/status') {
    return jsonOk(res, getFullStatus());
  }

  // ── GET /pingserver ────────────────────────────────────────────────────────
  if (path === '/pingserver') {
    if (!state.ip) return jsonError(res, 400, 'IP not set. Hit /ip?value=x first');
    pingMinecraftServer(state.ip, state.port).then((result) => {
      state.lastServerPing = { ...result, ts: new Date().toISOString() };
      jsonOk(res, { message: 'Ping complete', result });
    }).catch((err) => {
      jsonError(res, 500, `Ping failed: ${err.message}`);
    });
    return; // async, don't fall through
  }

  // ── GET /ip?value=x ───────────────────────────────────────────────────────
  if (path === '/ip') {
    const value = query.value;
    if (!value) {
      // No value = clear IP
      const old = state.ip;
      state.ip = null;
      log('IP cleared');
      return jsonOk(res, { message: 'IP cleared', previousIp: old || null, readyToStart: false });
    }
    state.ip = value;
    log(`IP set to ${state.ip}`);
    return jsonOk(res, { message: `IP set to ${state.ip}`, ip: state.ip, port: state.port, readyToStart: state.portSet });
  }

  // ── GET /port?value=x ─────────────────────────────────────────────────────
  if (path === '/port') {
    const p = parseInt(query.value);
    if (!query.value || isNaN(p) || p < 1 || p > 65535)
      return jsonError(res, 400, 'Missing or invalid ?value=<1-65535>');
    state.port = p;
    state.portSet = true;
    log(`Port set to ${state.port}`);
    return jsonOk(res, { message: `Port set to ${state.port}`, ip: state.ip, port: state.port, readyToStart: !!state.ip });
  }

  // ── GET /rename?value=x ───────────────────────────────────────────────────
  if (path === '/rename') {
    const name = query.value;
    if (!name) return jsonError(res, 400, 'Missing ?value=<username>');
    if (name.length < 3 || name.length > 16) return jsonError(res, 400, 'Username must be 3–16 characters');
    if (!/^[a-zA-Z0-9_]+$/.test(name)) return jsonError(res, 400, 'Username can only contain a-z, 0-9, underscore');
    const old = state.botUsername;
    state.botUsername = name;
    log(`Bot renamed from ${old} to ${name}`);
    return jsonOk(res, { message: 'Bot renamed', oldUsername: old, newUsername: name, note: state.connected ? 'Use /stop then /start to apply' : 'Will apply on next /start' });
  }

  // ── GET /version?value=x ──────────────────────────────────────────────────
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

  // ── GET /start ─────────────────────────────────────────────────────────────
  if (path === '/start') {
    if (!state.ip && !state.portSet) return jsonError(res, 400, 'Both IP and Port are not set', { hint: 'Hit /ip?value=x and /port?value=x first' });
    if (!state.ip) return jsonError(res, 400, 'IP not set', { hint: 'Hit /ip?value=<address>', portAlreadySet: state.port });
    if (!state.portSet) return jsonError(res, 400, 'Port not set', { hint: 'Hit /port?value=25565', ipAlreadySet: state.ip });
    if (state.connected) return jsonError(res, 409, 'Bot is already connected', { server: `${state.ip}:${state.port}`, hint: 'Hit /stop first' });

    state.autoReconnect = true;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }

    // Ping server first, then decide whether to connect
    jsonOk(res, {
      message: `Pinging ${state.ip}:${state.port} before connecting...`,
      username: state.botUsername,
      note: 'Check /status or /health — bot will start if server is online with ≤1 player',
    });
    waitForServerOnline(); // async, runs in background
    return;
  }

  // ── GET /stop ──────────────────────────────────────────────────────────────
  if (path === '/stop') {
    if (!state.bot && !state.connected && state.pingPhase === 'idle') {
      return jsonError(res, 400, 'Bot is not running', { hint: 'Use /start to connect first' });
    }
    state.autoReconnect = false;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    stopServerPingTimers();
    state.pingPhase = 'idle';
    stopAllBotSystems();
    if (state.bot) {
      try { state.bot.quit('Stopped via API'); } catch (_) {}
      state.bot = null;
    }
    state.connected = false;
    log('Bot stopped via API');
    return jsonOk(res, { message: 'Bot stopped', autoReconnect: false });
  }

  // ── GET /jump ──────────────────────────────────────────────────────────────
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

  // ── GET /move ──────────────────────────────────────────────────────────────
  if (path === '/move') {
    if (!state.connected) return jsonError(res, 400, 'Bot is not connected', { hint: 'Use /start first' });
    const ok = startAutoMove();
    if (!ok) return jsonError(res, 500, 'Failed to start pathfinding move');
    return jsonOk(res, {
      message: 'Pathfinding auto-move started',
      intervalSeconds: 5,
      info: 'Bot will pathfind to safe nearby blocks. Falls back to raw movement if no path found.',
    });
  }

  // ── GET /sneak ─────────────────────────────────────────────────────────────
  if (path === '/sneak') {
    if (!state.connected) return jsonError(res, 400, 'Bot is not connected', { hint: 'Use /start first' });
    const ok = startSneak();
    if (!ok) return jsonError(res, 500, 'Failed to start sneak');
    return jsonOk(res, { message: 'Sneak mode activated', jumpStopped: true });
  }

  // ── GET /stopaction ────────────────────────────────────────────────────────
  if (path === '/stopaction') {
    clearAllActions();
    log('All actions stopped via API');
    return jsonOk(res, { message: 'All actions stopped', jump: false, move: false, sneak: false, pathfinding: false });
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  return jsonError(res, 404, `Unknown endpoint: ${path}`, {
    availableEndpoints: [
      '/health', '/status', '/start', '/stop',
      '/jump', '/move', '/sneak', '/stopaction',
      '/ip?value=x', '/port?value=x', '/rename?value=x', '/version?value=x',
      '/pingserver',
    ],
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('🛡️  DERTORRAP ANTI AFK BOT v3.0');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/health`);
  console.log(`📡 All endpoints: http://localhost:${PORT}/status`);
  if (API_KEY) console.log('🔒 API key protection enabled');
  console.log('');
});

process.on('uncaughtException', (err) => { log(`Uncaught: ${err.message}`); });
process.on('unhandledRejection', (reason) => { log(`Rejection: ${reason}`); });
