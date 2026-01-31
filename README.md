# 🖖 LCARS Bridge Dashboard v7

**Star Trek LCARS-style command center for OpenClaw with task management, agent introspection, and multi-agent coordination.**

![LCARS](https://img.shields.io/badge/LCARS-47.6-orange)
![Status](https://img.shields.io/badge/Status-Production-green)
![Version](https://img.shields.io/badge/Version-7.0-blue)

## What's New in v7

### Task & Agent Management System
- **Full Kanban board** - Inbox → Assigned → In Progress → Review → Done
- **12 crew members** - Seven, Geordi, Spock, Uhura, Quark, Data, B'Elanna, Harry, Icheb, Tom, Neelix, Tuvok, Doctor
- **Multi-Agent Peer Review** - Team of Rivals system with cross-discipline pairings
- **Work Loop integration** - Auto-routing tasks to appropriate crew members
- **Agent direct messaging** - @mention routing to specific agents

### New Dashboard Panels
- **System Tasks** - Real-time cron job status (Email Triage, Crew Heartbeat, Health Checks, Polymarket Tracker)
- **Activity Feed** - Filterable by task/tool/thinking/status
- **Lessons Learned** - Meta-learning system insights from past mistakes
- **Sessions** - Full OpenClaw session introspection with crew name matching
- **Messages** - Inter-agent communication panel

### Backend Features
- **Checkpoint System** - State snapshots before critical operations
- **Decision Lineage** - Full audit trail of all decisions
- **Git Conflict Detection** - Prevents agent overwrites
- **Self-Healing Watchdog** - 13 health checks with auto-recovery
- **Stall Detection** - Monitors agent activity and alerts on stalls

### Visual Enhancements (from v6)
- **Starfield background** - Animated twinkling stars
- **Scanlines overlay** - Classic CRT effect (toggle with `T`)
- **Panel animations** - Smooth fade-in with staggered timing
- **Glow effects** - Active elements pulse
- **Improved readability** - Minimum 12px font sizes

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `N` | New Task |
| `M` | Messages |
| `T` | Toggle Scanlines |
| `R` | Refresh |
| `Esc` | Close Modals |

## Crew Panels

| Crew | Role | Specialty |
|------|------|-----------|
| Seven of Nine | Number One | Orchestration, delegation |
| Geordi La Forge | Chief Engineer | Dashboard, infrastructure |
| Spock | Science Officer | Research, logic analysis |
| Uhura | Comms Officer | Email, communications |
| Quark | Trade Advisor | Polymarket, trading |
| Data | QC Officer | Quality control, verification |
| B'Elanna Torres | Chief Engineer | Practical solutions |
| Harry Kim | Operations | System monitoring |
| Icheb | Borg Specialist | Code optimization |
| Tom Paris | Risk Trader | Speculation analysis |
| Neelix | Resource Mgmt | Risk mitigation |
| Tuvok | Security/Research | Security assessment |
| The Doctor | EMH Research | Empirical research |

## Quick Start

```bash
cd ~/.openclaw/dashboard

# Start the dashboard
./start.sh

# Or manually:
node server.js
```

Open in browser: **http://localhost:4242**

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard HTML |
| `GET /health` | Server health check |
| `GET /api/data` | Bridge data (JSON) |
| `GET /api/tasks` | Task list with activity |
| `POST /api/tasks` | Create new task |
| `DELETE /api/tasks/:id` | Delete task |
| `GET /api/sessions` | OpenClaw sessions |
| `GET /api/cron` | Cron job status |
| `GET /api/messages` | Crew messages |
| `GET /api/meta-learning` | Lessons learned |
| `GET /api/checkpoints` | Checkpoint status |
| `GET /api/git-locks` | Git lock status |
| `GET /api/stall` | Stall detection status |
| `GET /api/work-loop` | Work loop status |
| `WS /` | WebSocket for real-time updates |

## Data Sources

- **Tasks**: `~/.openclaw/dashboard/tasks.json`
- **Messages**: `~/.openclaw/crew/messages.json`
- **Sessions**: OpenClaw Gateway API (port 18789)
- **Crons**: OpenClaw cron list API
- **Quark**: `~/.openclaw/workspace/quark/portfolio.json`
- **Git**: Workspace and skills directories
- **System**: `/proc` filesystem

## Configuration

Environment variables:
- `LCARS_PORT` - Server port (default: 4242)

## Files

```
~/.openclaw/dashboard/
├── index.html      # Dashboard frontend (v7)
├── server.js       # Node.js WebSocket server
├── tasks.json      # Task data store
├── package.json    # Dependencies
├── start.sh        # Startup script
├── test.sh         # Test script
└── README.md       # This file
```

## Related Scripts

```
~/.openclaw/crew/
├── crew-task.js        # Task management CLI (v2.0 with peer review)
├── crew-log.js         # Activity logging
├── crew-audit.js       # Decision lineage
├── crew-checkpoint.js  # State snapshots
├── crew-msg.js         # Inter-agent messaging
├── meta-learning.js    # Lessons learned
└── work-loop.js        # Auto task routing
```

## Requirements

- Node.js 18+
- `ws` package (auto-installed)
- OpenClaw gateway running (for session data)

## Changelog

### v7.0
- Complete task management system (Kanban)
- 12 crew member support
- Multi-agent peer review (Team of Rivals)
- Work loop integration
- Agent direct messaging (@mentions)
- System Tasks panel
- Activity feed with filters
- Messages panel
- Lessons learned panel
- Checkpoint API
- Git conflict detection API
- Stall detection API
- Improved font readability (min 12px)

### v6.0
- Starfield background animation
- Scanlines CRT effect
- Panel entrance animations
- Alert ticker
- Sessions panel
- Keyboard shortcuts
- Dynamic color coding

### v5.0
- Initial production release
- All crew panels
- Real-time WebSocket updates
- Sparkline charts for trading

## Live Long and Prosper 🖖
