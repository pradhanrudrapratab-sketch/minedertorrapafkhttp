# 🛡️ DERTORRAP ANTI AFK BOT v3.0

A 24/7 Minecraft Anti-AFK bot controlled via **HTTP endpoints**. Comes with smart server ping, pathfinding movement, hostile mob combat, water survival, and a live dashboard at `/health`.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🌐 **Smart Server Ping** | Pings server before connecting. If offline, retries every 15s. If 2+ players, stops bot and monitors every 60s |
| 🚶 **Pathfinding Move** | Uses `mineflayer-pathfinder` to walk to safe nearby blocks. Finds alternate safe spot if blocked. Falls back to raw movement |
| ⚔️ **Auto Combat** | Scans for hostile mobs within 4.5 blocks every second and attacks automatically |
| 🌊 **Water Survival** | Holds jump (swim up) whenever bot enters water. Releases when back on land |
| 🐸 **Auto Jump** | Jumps every 3 seconds to stay active |
| 🦆 **Sneak Mode** | Holds sneak to prevent falling off edges |
| 🔄 **Auto Reconnect** | Reconnects 15 seconds after kick or disconnect |
| 🔒 **API Key Auth** | Optional secret key to protect all endpoints |
| 📊 **Live Dashboard** | Real-time HTML dashboard at `/health` with stats, logs, and ping info |

---

## ⚡ Quick Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Create `.env` File
```bash
cp .env.example .env
```

Fill in your values:

| Variable | Description | Default |
|---|---|---|
| `MC_IP` | Minecraft server IP | — |
| `MC_PORT` | Server port | `25565` |
| `MC_USERNAME` | Bot's in-game name | `BotPlayer` |
| `MC_AUTH` | `offline` (cracked) or `microsoft` (premium) | `offline` |
| `MC_VERSION` | e.g. `1.20.1` — leave empty for auto-detect | auto |
| `PORT` | HTTP server port | `3000` |
| `API_KEY` | Optional — protects all endpoints | — |

### 3. Run
```bash
npm start
```

---

## 🌐 HTTP Endpoints

All endpoints return **JSON**. `/health` also serves an HTML dashboard in browsers.

### ⚙️ Setup

| Endpoint | Description |
|---|---|
| `GET /ip?value=mc.server.com` | Set server IP |
| `GET /ip` | **Clear server IP** (no value = reset to null) |
| `GET /port?value=25565` | Set server port |
| `GET /rename?value=CoolBot` | Rename bot (3–16 chars, a-z 0-9 _) |
| `GET /version?value=1.20.1` | Pin Minecraft version |
| `GET /version?value=auto` | Reset to auto-detect |

### 🎮 Bot Control

| Endpoint | Description |
|---|---|
| `GET /start` | Ping server → connect bot if server online + ≤1 player |
| `GET /stop` | Disconnect bot + stop all systems |

### 🕹️ Anti-AFK Actions

| Endpoint | Description |
|---|---|
| `GET /jump` | Auto-jump every 3 seconds (stops sneak) |
| `GET /move` | Pathfinding move to random safe block every 5s |
| `GET /sneak` | Sneak mode ON (stops jump) |
| `GET /stopaction` | Stop all active actions (jump / move / sneak) |

> ⚔️ **Combat** and 🌊 **Water Survival** run automatically after bot spawns — no manual trigger needed.

### 🌐 Server Ping

| Endpoint | Description |
|---|---|
| `GET /pingserver` | Manual ping — returns online status, player count, version, latency |

### 📊 Info

| Endpoint | Description |
|---|---|
| `GET /health` | **HTML dashboard** in browser, JSON via API |
| `GET /status` | Full JSON status (health, pos, ping, uptime, server ping, logs) |

---

## 🤖 Smart Server Ping Logic

When you hit `/start`, the bot does **not** connect immediately. Instead:

```
/start hit
    ↓
Ping server
    ↓
Offline? → Retry every 15s until online
    ↓
Online + players ≤ 1? → Connect bot
    ↓
Online + players ≥ 2? → Stay disconnected, monitor every 60s
    ↓
While connected → Check every 60s
    ├── Players ≥ 2 → Disconnect bot, keep monitoring
    └── Players ≤ 1 → Keep running (or reconnect if stopped)
```

**Manual ping anytime:**
```
GET /pingserver
```
Response:
```json
{
  "online": true,
  "playerCount": 1,
  "maxPlayers": 20,
  "version": "1.20.1",
  "latency": 42
}
```

---

## 🚶 Pathfinding Move (`/move`)

Unlike basic random movement, `/move` uses `mineflayer-pathfinder`:

1. Picks a random block **3–8 blocks away**
2. Checks if it's **walkable** (solid ground, air at feet and head)
3. If not walkable → **spiral-scans up to 10 blocks** for a safe spot
4. If no safe spot found → **falls back to raw directional movement**
5. Repeats every **5 seconds**

Bot will never pathfind into walls, off cliffs, or into water.

---

## ⚔️ Auto Combat

Runs automatically after bot spawns. Every **1 second**:

- Scans for hostile mobs within **4.5 blocks**
- If found: `lookAt()` → `attack()`

**Hostile mobs tracked:**
zombie, skeleton, creeper, spider, cave_spider, witch, blaze, ghast, slime, magma_cube, enderman, endermite, silverfish, phantom, drowned, husk, stray, wither_skeleton, pillager, vindicator, evoker, ravager, guardian, elder_guardian, shulker, vex, zombie_villager, zombified_piglin, piglin_brute, hoglin, zoglin, warden

---

## 🌊 Water Survival

Runs automatically after bot spawns. Every **500ms**:

- If bot is in water → holds `jump` (swim up)
- If bot exits water → releases `jump`

Compatible with Auto-Jump — they don't conflict.

---

## 📊 Live Dashboard (`/health`)

Open `https://your-app.onrender.com/health` in your browser:

- 🟢 Connection status with animated dot
- 🌐 Server ping status — online/offline, player count, latency, version
- ⚙️ Setup info (IP, port, username, version)
- ⚡ Live stats — HP, food, position, ping, dimension, water status
- 🕹️ Active systems badges (jump / pathfinding / sneak / combat / water guard)
- 📋 Recent logs (last 10 events)
- 🔗 All endpoints listed
- 🔄 Auto-refreshes every 15 seconds

---

## 🔒 API Key Protection (Optional)

Set `API_KEY` in `.env`:
```env
API_KEY=mysecretkey123
```

Add `?key=mysecretkey123` to every request:
```
/start?key=mysecretkey123
/jump?key=mysecretkey123
/status?key=mysecretkey123
```

Without the key → `401 Unauthorized`

> `/health` is always public so UptimeRobot can ping it freely.

---

## ☁️ Deploy to Render.com

1. Push code to GitHub
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your GitHub repository
4. Fill in settings:

| Field | Value |
|---|---|
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node index.js` |

5. Add your `.env` values under **Environment Variables**
6. Click **Deploy** ✅

> ⚠️ Render free tier may block outbound ports to some servers (e.g. Aternos). If connection fails, try **Railway** or **Koyeb** — both allow outbound ports on free tier.

---

## 📡 UptimeRobot Setup (Keep Render Awake)

Render's free tier sleeps after 15 minutes of no traffic. UptimeRobot fixes this.

1. Go to [uptimerobot.com](https://uptimerobot.com) → Create free account
2. **Add New Monitor**
3. Fill in:

| Field | Value |
|---|---|
| **Monitor Type** | `HTTP(s)` |
| **Friendly Name** | `Dertorrap Bot` |
| **URL** | `https://your-app.onrender.com/health` |
| **Monitoring Interval** | `5 minutes` |

4. **Create Monitor** ✅

---

## 🧠 Smart Error Handling

| Situation | Response |
|---|---|
| `/start` without IP | `400` — set IP first |
| `/start` without Port | `400` — set Port first |
| `/start` when connected | `409` — use `/stop` first |
| `/start` + server offline | Retries ping every 15s in background |
| `/start` + 2+ players | Waits and monitors every 60s |
| `/jump` / `/move` / `/sneak` when not connected | `400` — use `/start` first |
| `/ip` with no value | Clears IP, returns `previousIp` |
| Invalid IP / Port / name | `400` with clear hint |
| Unknown endpoint | `404` with list of valid endpoints |
| Pathfinder no path | Falls back to raw movement |
| Bot in water | Auto holds jump to swim up |
| Hostile mob nearby | Auto attacks within 4.5 blocks |

---

## 🔄 Auto Features

| Feature | Behaviour |
|---|---|
| Auto-reconnect | Reconnects every 15 seconds after kick/disconnect |
| Auto-respawn | Bot respawns automatically on death |
| Server monitoring | Checks player count every 60s while connected |
| Server wait | Pings every 15s if server offline at start |
| Auto combat | Attacks hostile mobs within 4.5 blocks every second |
| Water survival | Holds jump when in water every 500ms |
| Recent logs | Last 20 events stored, viewable on dashboard |

---

## 📦 Dependencies

| Package | Version | Purpose |
|---|---|---|
| `mineflayer` | `^4.23.0` | Minecraft bot API |
| `mineflayer-pathfinder` | `^2.4.5` | Pathfinding plugin |
| `minecraft-data` | `^3.63.0` | Block & entity data |
| `dotenv` | `^16.4.5` | Environment variables |

> Server ping uses Node.js built-in `net` module — no extra package needed.
