# TUI Library Research — Session 97

**Date**: 2026-03-24
**Decision**: Zero new dependencies — use Node.js built-ins + ANSI escape codes

## Libraries Evaluated

### 1. ink (React for CLI)
- **Bundle size**: Heavy — pulls in React (~50KB) + Yoga layout engine (C++ WASM)
- **TypeScript**: First-class, but JSX required
- **Streaming**: Possible with `useState` + custom hook, but React reconciler adds overhead for token-by-token updates
- **Layout**: Excellent — flexbox via Yoga
- **Maintenance**: Active (Vadim Demedes, GitHub trending)
- **ESM**: Yes (v5+)
- **Verdict**: Overkill for a REPL. React renders a virtual DOM for a chat window, which is unnecessary complexity.

### 2. @clack/prompts
- **Bundle size**: ~15KB, focused
- **TypeScript**: Good
- **Streaming**: Not designed for it — shows spinners/selects but no raw text streaming area
- **Layout**: None — single-line prompts only
- **Maintenance**: Active (natemoo-re)
- **ESM**: Yes
- **Verdict**: Great for setup wizards, not suitable for an ongoing conversation UI.

### 3. blessed / neo-blessed
- **Bundle size**: ~400KB, full terminal emulator
- **TypeScript**: Types available but stale (2021)
- **Streaming**: Yes — can append to Box widgets
- **Layout**: Excellent — split panes, scrollable boxes, borders
- **Maintenance**: Essentially dead (last commit 2021)
- **ESM**: CJS only — would require wrapper hacks
- **Verdict**: Would require `createRequire` gymnastics. Dead project.

### 4. terminal-kit
- **Bundle size**: ~200KB with many transitive deps
- **TypeScript**: Types available, not great DX
- **Streaming**: Yes — `.insert()` for text, `.progressBar()` for spinners
- **Layout**: Moderate — no true split-pane
- **Maintenance**: Moderate (creeot, sporadic commits)
- **ESM**: Partial — has `index.mjs` but not fully ESM-clean
- **Verdict**: API is complex, documentation is thin, not worth the weight.

### 5. @inquirer/prompts (Inquirer v9+)
- **Bundle size**: ~30KB modular
- **TypeScript**: Excellent, fully typed
- **Streaming**: Not designed for it
- **Layout**: None — prompt-by-prompt
- **Maintenance**: Active (SBoudrias)
- **ESM**: Yes
- **Verdict**: Best-in-class for prompts, wrong tool for a streaming REPL.

## Decision: Zero New Dependencies

All required features can be implemented with **Node.js built-ins + ANSI escape codes**:

| Feature | Implementation |
|---------|---------------|
| Status bar | ANSI scroll region (`\x1B[1;{rows-1}r`) + cursor positioning |
| Spinner | `setInterval` + braille characters (already in cli-chat.ts) |
| Syntax highlighting | Regex-based code fence detection + ANSI colors |
| Streaming | Anthropic SSE API via `fetch` + `ReadableStream` (Node 18+) |
| Resize handling | `process.on('SIGWINCH', ...)` |
| Input | `readline/promises` (existing) |

This keeps Ved at **3 runtime dependencies** (better-sqlite3, ulid, yaml) and avoids any ESM/CJS compatibility issues.

## Streaming Architecture

The LLM pipeline runs RECEIVE → ENRICH → DECIDE → ACT → RESPOND → MAINTAIN → AUDIT.
Streaming tokens come from the DECIDE stage (LLM call).

New method `processMessageStream(msg, onToken)`:
- Steps 1-2 (RECEIVE, ENRICH): run synchronously as before
- Step 3 (DECIDE): calls `llm.chatStream(request, onToken)` — yields text tokens via callback
- Steps 4-7 (ACT, RESPOND, MAINTAIN, AUDIT): run after stream completes with accumulated text

If the provider doesn't support streaming (OpenAI fallback, Ollama), `chatStream` calls the regular `chat` and delivers the full response in one shot.

## TUI Design

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Ved Chat  ●  anthropic / claude-3-5-sonnet                         │
  │  The personal AI agent that remembers everything.                   │
  │  Type /help for commands, /quit to exit.                            │
  └─────────────────────────────────────────────────────────────────────┘

you> what's the weather like?

ved>  ⠙ thinking...

ved>
  The weather API isn't in my toolset, but I can help you with anything
  stored in your vault!

  Try: /search weather

you> show me a code example

ved>
  Here's a quick TypeScript example:

  ┌─ typescript ──────────────────────────────────────────────────
  │  const x: number = 42;
  │  console.log(`Value: ${x}`);
  └───────────────────────────────────────────────────────────────

you> _

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 sess: 01JXXX… │ msgs: 3 │ 2m 14s │ claude-3-5-sonnet │ owner ●
```

Key design choices:
- **Scroll region** reserves the last terminal line for the status bar
- **Code blocks** rendered with a top/bottom border + line prefix `│`
- **Inline streaming** — tokens printed in real-time, no wait-for-complete
- **Clean scrollback** — conversation scrolls naturally within the scroll region
