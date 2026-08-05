# 🛡️ DERTORRAP ANTI AFK BOT

A 24/7 Minecraft Anti-AFK bot fully controlled via Telegram. Auto-reconnects on disconnect, smart setup validation, health endpoint for Render.com uptime, and rich status reporting.

---

## ⚡ Quick Setup

### 1. Install
```bash
npm install
```

### 2. Create `.env`
```bash
cp .env.example .env
```

Fill in your values:

| Variable | Description |
|---|---|
| `TELEGRAM_TOKEN` | From [@BotFather](https://t.me/BotFather) |
| `ALLOWED_CHAT_ID` | Your user ID from [@userinfobot](https://t.me/userinfobot) |
| `MC_USERNAME` | Bot's in-game name |
| `MC_AUTH` | `offline` (cracked) or `microsoft` (premium) |
| `MC_VERSION` | e.g. `1.20.1` or leave empty for auto |
| `PORT` | Health server port (default: `3000`) |

### 3. Run
```bash
npm start
```

---

## 📱 Telegram Commands

### ⚙️ Setup
| Command | Description |
|---|---|
| `/ip <address>` | Set Minecraft server IP |
| `/port <number>` | Set server port (default: 25565) |
| `/rename <name>` | Rename the bot (3–16 chars, a-z 0-9 _) |

### 🎮 Bot Control
| Command | Description |
|---|---|
| `/start` | Connect to server + enable auto-reconnect |
| `/stop` | Disconnect + disable auto-reconnect |

### 🕹️ Anti-AFK Actions
| Command | Description |
|---|---|
| `/jump` | Auto-jump every 3 seconds (stops sneak) |
| `/move` | Random direction movement every 1 second |
| `/sneak` | Sneak mode ON (stops jump) |
| `/stopaction` | Stop ALL active actions |

### 📊 Info
| Command | Description |
|---|---|
| `/status` | Full status: HP, food, pos, ping, uptime |
| `/help` | List all commands |

---

## 🧠 Smart Error Handling

- `/start` without IP → asks you to set IP first
- `/start` without Port → asks you to set Port first
- `/start` without both → tells you to set both, with hints
- `/start` when already connected → warns you to `/stop` first
- `/rename` validates length (3–16) and characters (a-z, 0-9, _)
- All action commands (`/jump`, `/move`, `/sneak`) check if bot is connected first

---

## 🌐 Health Endpoint (for Render + cron-job.org)

The bot runs an HTTP server at `/health` that returns live JSON status:

```json
{
  "status": "online",
  "service": "Dertorrap Anti AFK Bot",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "bot": {
    "connected": true,
    "server": "hypixel.net:25565",
    "username": "BotPlayer123",
    "autoReconnect": true,
    "uptimeSeconds": 3600,
    "actions": {
      "jump": true,
      "move": false,
      "sneak": false
    }
  }
}
```

**Setup on cron-job.org:**
1. Go to [cron-job.org](https://cron-job.org) → Create Cronjob
2. URL: `https://your-render-app.onrender.com/health`
3. Schedule: Every 5 minutes
4. This pings Render and prevents the free tier from sleeping!

---

## ☁️ Deploy to Render.com

1. Push code to GitHub
2. Go to Render → **New → Background Worker** _(NOT Web Service!)_
3. Connect your repo
4. Build Command: `npm install`
5. Start Command: `node index.js`
6. Add all `.env` values as Environment Variables
7. Deploy ✅

> ⚠️ Use **Background Worker**, not Web Service. Background Workers stay alive 24/7 on free tier without needing HTTP traffic.

---

## 🔄 Auto Features

| Feature | Behaviour |
|---|---|
| Auto-reconnect | Reconnects every 15s after kick/disconnect |
| Auto-respawn | Respawns bot automatically on death |
| Low health alert | Telegram warning when HP < 5 |
| Header banner | Every message shows `DERTORRAP ANTI AFK BOT` |
