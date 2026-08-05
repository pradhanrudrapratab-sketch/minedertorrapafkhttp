# 🛡️ DERTORRAP ANTI AFK BOT v2.0

A 24/7 Minecraft Anti-AFK bot controlled fully via **HTTP endpoints**. No Telegram needed — hit a URL and the bot responds. Comes with a beautiful live dashboard at `/health`.

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

| Variable | Description |
|---|---|
| `MC_IP` | Minecraft server IP (can also set via `/ip?value=x`) |
| `MC_PORT` | Server port — default `25565` |
| `MC_USERNAME` | Bot's in-game name |
| `MC_AUTH` | `offline` (cracked) or `microsoft` (premium) |
| `MC_VERSION` | e.g. `1.20.1` — leave empty for auto-detect |
| `PORT` | HTTP server port (default: `3000`) |
| `API_KEY` | Optional — protects all endpoints with a secret key |

### 3. Run
```bash
npm start
```

---

## 🌐 HTTP Endpoints

All endpoints return **JSON**. `/health` also serves an HTML dashboard in the browser.

### ⚙️ Setup
| Endpoint | Description |
|---|---|
| `GET /ip?value=mc.server.com` | Set server IP |
| `GET /port?value=25565` | Set server port |
| `GET /rename?value=CoolBot` | Rename bot (3–16 chars, a-z 0-9 _) |
| `GET /version?value=1.20.1` | Pin Minecraft version |
| `GET /version?value=auto` | Reset to auto-detect |

### 🎮 Bot Control
| Endpoint | Description |
|---|---|
| `GET /start` | Connect bot + enable auto-reconnect |
| `GET /stop` | Disconnect bot + disable auto-reconnect |

### 🕹️ Anti-AFK Actions
| Endpoint | Description |
|---|---|
| `GET /jump` | Auto-jump every 3 seconds (stops sneak) |
| `GET /move` | Random movement every 1 second |
| `GET /sneak` | Sneak mode ON (stops jump) |
| `GET /stopaction` | Stop ALL active actions |

### 📊 Info
| Endpoint | Description |
|---|---|
| `GET /health` | **HTML dashboard** in browser, JSON via API |
| `GET /status` | Full JSON status (health, pos, ping, uptime, logs) |

---

## 📊 Live Dashboard (`/health`)

Open `https://your-app.onrender.com/health` in your browser and you get a full live dashboard:

- 🟢 Connection status with animated dot
- ⚙️ Setup info (IP, port, username, version)
- ⚡ Live stats — HP, food, position, ping, dimension
- 🕹️ Active actions badges (jump / move / sneak)
- 📋 Recent logs (last 10 events)
- 🔗 All endpoints listed
- 🔄 Auto-refreshes every 15 seconds

---

## 🔒 API Key Protection (Optional)

To protect your endpoints from unauthorized access, set `API_KEY` in `.env`:

```env
API_KEY=mysecretkey123
```

Then add `?key=mysecretkey123` to every request:

```
/start?key=mysecretkey123
/jump?key=mysecretkey123
/status?key=mysecretkey123
```

Without the key → `401 Unauthorized`

> `/health` is always public so UptimeRobot can ping it freely.

---

## 🧠 Smart Error Handling

| Situation | Response |
|---|---|
| `/start` without IP | `400` — tells you to set IP first |
| `/start` without Port | `400` — tells you to set Port first |
| `/start` without both | `400` — tells you to set both |
| `/start` when connected | `409` — says use `/stop` first |
| `/jump` / `/move` / `/sneak` when not connected | `400` — says use `/start` first |
| Invalid IP / Port / name | `400` with clear hint |
| Unknown endpoint | `404` with list of valid endpoints |

All errors include a `hint` field in JSON to guide you on what to do next.

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

> `/health` has no API key requirement so UptimeRobot works without any extra config.

---

## 🔄 Auto Features

| Feature | Behaviour |
|---|---|
| Auto-reconnect | Reconnects every 15 seconds after kick/disconnect |
| Auto-respawn | Bot respawns automatically on death |
| Version mismatch | Auto-stops reconnect loop, logs the error |
| Recent logs | Last 20 events stored, viewable on dashboard |
