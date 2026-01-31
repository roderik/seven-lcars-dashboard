# LCARS Bridge Dashboard v5

Production-ready Star Trek LCARS-themed dashboard for monitoring OpenClaw crew agents and system status.

![LCARS Design](https://img.shields.io/badge/design-LCARS-ff9900)
![WebSocket](https://img.shields.io/badge/realtime-WebSocket-99ccff)
![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933)

## Features

### 🖖 Crew Monitoring
- **Seven of Nine** (Command) - Main agent sessions and efficiency
- **Spock** (Science) - Research tasks and findings
- **Geordi La Forge** (Engineering) - Git status, worktrees, commits
- **Nyota Uhura** (Communications) - Email counts by account
- **Quark** (Trading) - Crypto balance, P&L, win rate, trade history

### 📊 Data Visualization
- Real-time balance sparkline charts
- Progress bars for all metrics
- Live trade history feed
- Pending trade alerts with animation

### 💻 System Monitoring
- CPU, Memory, Disk usage
- Network I/O rates
- Docker container counts
- CPU temperature
- Load averages

### 🎨 Authentic LCARS Design
- True LCARS color palette
- Curved elbows and rounded corners
- Antonio font for authentic typography
- Smooth animations and transitions
- Responsive layout for all screen sizes

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start

# Development mode (auto-restart)
npm run dev
```

Open http://localhost:4242 in your browser.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard HTML |
| `GET /health` | Health check (JSON) |
| `GET /api/data` | Current data snapshot (JSON) |
| `WS /` | WebSocket for real-time updates |

## Data Sources

The dashboard collects data from:

1. **Quark Portfolio** - `~/.openclaw/workspace/quark/portfolio.json`
2. **OpenClaw Sessions** - `http://127.0.0.1:4000/api/sessions`
3. **Git Status** - Workspace and skills directories
4. **Email** - Via `gog gmail search` commands
5. **System** - `/proc` filesystem and shell commands

## Configuration

Environment variables:
- `LCARS_PORT` - Server port (default: 4242)

## WebSocket Protocol

Messages are JSON with `type` field:
- `init` - Initial data on connection
- `update` - Periodic updates (every 5s)
- `trade_update` - Triggered by portfolio changes

## License

Starfleet Command - Make it so! 🖖
