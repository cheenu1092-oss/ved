# Session 81 — `ved notify` — Notification Rules Manager

**Date:** 2026-03-10
**Phase:** CYCLE (feature development)
**Duration:** ~1 session

## What Was Built

### `ved notify` CLI (12 subcommands)
New notification rules engine. Subscribes to EventBus events and delivers user-facing notifications through multiple channels.

**Subcommands:**
- `ved notify list` — List all rules (with mute status)
- `ved notify add <name> <events> <channel>` — Create a rule
- `ved notify remove <name>` — Remove a rule
- `ved notify show <name>` — Show details + recent history
- `ved notify edit <name> [flags]` — Update rule properties
- `ved notify enable <name>` — Enable a disabled rule
- `ved notify disable <name>` — Disable a rule
- `ved notify test <name>` — Test-fire with synthetic event
- `ved notify history [name]` — Show delivery history
- `ved notify channels` — List available channels
- `ved notify mute [duration]` — Mute all (optional: 30m, 1h, 2d)
- `ved notify unmute` — Unmute notifications

**Aliases:** `ved notifications`, `ved alert`, `ved alerts`

### 4 Delivery Channels
1. **terminal** — Bell character + colored banner in stdout
2. **desktop** — Native OS notification (macOS `osascript` / Linux `notify-send`)
3. **command** — Custom shell command (event JSON on stdin, dangerous command blocking)
4. **log** — Append to notification log file

### Key Features
- **Template system** — `{type}`, `{actor}`, `{session}`, `{detail}`, `{id}`, `{timestamp}` placeholders in title/body
- **Throttling** — Per-rule minimum interval (ms) between notifications
- **Quiet hours** — HH:MM start/end, supports overnight windows (e.g., 22:00-07:00)
- **Global mute** — Mute all notifications with optional duration, auto-unmute on expiry
- **Delivery history** — All deliveries + suppressions logged (500 max)
- **Suppression tracking** — Records reason (muted/throttled/quiet_hours) in history
- **NotifyRunner class** — Runtime integration with EventBus for live event delivery
- **Dangerous command blocking** — Same patterns as hooks (rm -rf /, sudo, dd, fork bombs, etc.)
- **Name validation** — Same rules as hooks/aliases (letter-start, 64 char max, reserved names blocked)
- **YAML persistence** — `~/.ved/notify-rules.yaml`

### Differentiation from Hooks/Webhooks
| Feature | Hooks | Webhooks | Notify |
|---------|-------|----------|--------|
| Delivery | Shell command | HTTP POST | Terminal/Desktop/Command/Log |
| Throttling | No | No | Yes (per-rule) |
| Quiet hours | No | No | Yes |
| Global mute | No | No | Yes |
| Template system | No | No | Yes (title/body) |
| Purpose | Automation | Integration | User alerting |

## Files Changed
- **New:** `src/cli-notify.ts` (~580 lines)
- **New:** `src/cli-notify.test.ts` (~42 tests)
- **Modified:** `src/cli.ts` (added notify case + import)
- **Modified:** `src/cli-help.ts` (added notify command entry)
- **Modified:** `src/app.ts` (completions for bash/zsh/fish)

## Test Results
- **42 new tests** covering: name validation, template rendering, quiet hours, rule CRUD, mute state, delivery channels, NotifyRunner (matching/skipping/disabled/mute/throttle/templates/history/errors/multi-rule), CLI commands
- **2298/2298 pass** (host + Docker parity)
- **0 type errors**

## Stats
- CLI commands: 33
- Total tests: 2298
