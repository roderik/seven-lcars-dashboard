# 🖖 LCARS Bridge Dashboard v6

**Enhanced Star Trek LCARS-style dashboard for OpenClaw with agent introspection**

![LCARS](https://img.shields.io/badge/LCARS-47.6-orange)
![Status](https://img.shields.io/badge/Status-Production-green)
![Version](https://img.shields.io/badge/Version-6.0-blue)

## What's New in v6

### Visual Enhancements
- **Starfield background** - Animated twinkling stars for authentic space feel
- **Scanlines overlay** - Classic CRT monitor effect (toggle with `T`)
- **Panel entrance animations** - Smooth fade-in with staggered timing
- **Glow effects** - Active elements pulse and glow
- **Shimmer animations** - Subtle light sweep on bars and buttons
- **Enhanced hover states** - Panels and buttons respond to interaction

### New Features
- **Alert ticker** - Scrolling status bar with real-time system alerts
- **Sessions panel** - Full agent/subagent introspection (see below)
- **Keyboard shortcuts** - Quick navigation with number keys
- **Dynamic status colors** - CPU/memory bars change color based on load
- **Panel highlighting** - Click sidebar to highlight target panel

### Agent Introspection (Sessions Panel)
Real-time visibility into all OpenClaw sessions:
- Active session count (running vs total)
- Session labels and identifiers
- Status indicators with pulse animations
- Channel type (telegram, cli, etc.)
- Session duration (auto-updating)
- Model being used
- Sorted by status (running first)

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1` | Jump to Seven of Nine |
| `2` | Jump to Spock |
| `3` | Jump to Geordi |
| `4` | Jump to Uhura |
| `5` | Jump to Quark |
| `6` | Jump to System |
| `7` | Jump to Sessions |
| `R` | Request refresh |
| `T` | Toggle scanlines |

## Crew Panels

- **Seven of Nine** - Main agent sessions and efficiency
- **Spock** - Research tasks and logic analysis
- **Geordi La Forge** - Git status, commits, and engineering tasks
- **Uhura** - Email counts and communications
- **Quark** - Trading P&L with sparkline charts
- **System** - CPU/Memory/Disk with dynamic color coding
- **Sessions** - Full agent introspection

## Quick Start

```bash
cd ~/.openclaw/dashboard

# Start the dashboard
./start.sh

# Or manually:
node server.js
```

Open in browser: **http://localhost:4242**

## Testing

```bash
# Run tests
./test.sh

# Manual health check
curl http://localhost:4242/health

# Get API data
curl http://localhost:4242/api/data | jq
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard HTML |
| `GET /health` | Server health check |
| `GET /api/data` | Current bridge data (JSON) |
| `WS /` | WebSocket for real-time updates |

## Data Sources

- **Seven**: OpenClaw session API (`/api/sessions`)
- **Spock**: Session analysis (research-related)
- **Geordi**: Git status and worktrees
- **Uhura**: Email counts via `gog gmail`
- **Quark**: Portfolio from `~/.openclaw/workspace/quark/portfolio.json`
- **Sessions**: Full session list with metadata
- **System**: `/proc` filesystem

## Configuration

Environment variables:
- `LCARS_PORT` - Server port (default: 4242)

## Files

```
~/.openclaw/dashboard/
├── index.html      # Dashboard frontend (v6)
├── server.js       # Node.js WebSocket server
├── package.json    # Dependencies
├── start.sh        # Startup script
├── test.sh         # Test script
└── README.md       # This file
```

## Requirements

- Node.js 18+
- `ws` package (auto-installed)
- OpenClaw gateway running (for session data)

## Changelog

### v6.0
- Added starfield background animation
- Added scanlines CRT effect with toggle
- Added panel entrance animations
- Added alert ticker with system status
- Added Sessions panel for agent introspection
- Added keyboard shortcuts for navigation
- Added dynamic color coding for system stats
- Added glow and shimmer effects
- Improved hover states and transitions
- Improved panel highlighting on navigation

### v5.0
- Initial production release
- All crew panels implemented
- Real-time WebSocket updates
- Sparkline charts for trading

## Live Long and Prosper 🖖
