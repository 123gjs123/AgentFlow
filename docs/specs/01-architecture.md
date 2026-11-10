# 01 — Architecture

**Status:** Implemented

## Summary

A single Node.js process serves the React UI and a JSON/WebSocket API. Each piece of AI work (a step run, a chat turn, the router, flow generation) spawns the local **Claude Code CLI** in headless mode and parses its `stream-json` output into normalized events. Those events are persisted and broadcast to the UI live.

## Goals
- Use the user's Anthropic **subscription** through Claude Code. No API key.
- Reuse everything already configured in Claude Code: skills, agents, plugins, MCP connectors, settings.
- Stream the model's internal process to the UI in real time.
- Zero infrastructure: one `npm start`, with files on disk as the database.

## Non-goals
- Multi-user or hosted deployment.
- Calling the Anthropic API SDK directly.

## Components

```
Browser (React UI) ──HTTP /api/*──► Express server ──spawn──► claude.exe -p --output-format stream-json
        ▲                                │  ▲                        │
        └────────── WebSocket /ws ◄──── bus (EventEmitter) ◄────────┘ normalized events
                                         │
              CLI (bin/afs.js) ─┐        ▼
              MCP (bin/mcp.js) ─┼─► /api/ext/* (token) ──► engine (runs, chats)
              CI / webhooks ────┘        │
                                         ▼
                                    data/ (JSON files)
```

| Module | Responsibility |
|---|---|
| `server/index.js` | Express app. It serves the UI API (`/api/*`, loopback only) and the external API (`/api/ext/*`, token). It hosts Vite in dev or `dist/` in production, plus the WebSocket `/ws`. |
| `server/engine.js` | Flow execution (topological levels, parallelism, skip-on-failure), hooks, step chats, the general chat router, proposals, memory, schedules, run summaries and AI flow generation. |
| `server/claude.js` | Locates and spawns the Claude Code binary and normalizes stream events. It also tracks the last `init` (tools, MCP servers) and rate-limit info. |
| `server/prompt.js` | Builds every system and user prompt, does template rendering (`{{input}}`, `{{vars.x}}`…), and parses tags (`<remember>`, `<step-update>`). |
| `server/store.js` | JSON persistence with atomic writes (tmp file + rename). It also generates the API token. |
| `server/catalog.js` | Discovers skills and agents in `~/.claude/skills`, `~/.claude/agents`, the plugin cache and `<cwd>/.claude`. |
| `client/` | React UI: canvas, side panels, chat, events viewer, help, tour. |
| `bin/` | `afs` CLI and `afs-mcp` MCP server, both thin clients of `/api/ext`. |

## Claude Code integration

**Binary resolution:** the `CLAUDE_BIN` env var wins. On Windows the app then tries `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`, otherwise `claude` on `PATH`. The binary is spawned directly, without a shell, so arguments are never shell-interpreted.

**Flags used**

| Purpose | Flags |
|---|---|
| Headless streaming | `-p --output-format stream-json --verbose --include-partial-messages` |
| Step instructions | `--append-system-prompt-file <tmp>` (keeps Claude Code's default prompt) |
| Router / generator | `--system-prompt-file <tmp> --tools "" --strict-mcp-config --no-session-persistence` |
| Agent steps | `--agent <name>` |
| Model / effort | `--model`, `--effort` |
| Permissions | `--permission-mode`, `--allowedTools`, `--add-dir` |
| Chat continuity | `--resume <sessionId>` |

**Normalized event kinds** (`normalize()` in `claude.js`):

| Kind | Source | Used for |
|---|---|---|
| `init` | `system/init` | Model, session id, tool count, MCP servers and their status |
| `thinking_tokens` | `system/thinking_tokens` | Live "thinking (~N tokens)" spinner |
| `rate_limit` | `rate_limit_event` | Subscription usage badge (5-hour / 7-day windows) |
| `delta`, `thinking_delta` | `stream_event` | Live text streaming (not persisted) |
| `thinking`, `text`, `tool_use` | `assistant` blocks | Internal process panel |
| `tool_result` | `user` blocks | Paired with the matching `tool_use` |
| `result` | `result` | Final text, session id, usage, cost, denied permissions |
| `error` | spawn / exit failure | Error display |

Events from sub-agents carry `sub: true` and are indented in the UI.

**Probe:** `probeInit(cwd)` starts the CLI, reads only the `init` event and kills the process. This discovers the available tools and MCP servers without a model call.

## Real-time channel

`engine.bus` emits messages: `flow.updated`, `run.started`, `run.event`, `step.status`, `run.finished`, `chat.message`, `chat.event`, `chat.done`. The server relays every message to all WebSocket clients. The UI filters by `flowId` and keeps the canvas, activity panel and chat in sync, with auto-reconnect.

## Persistence (current layout)

```
data/
  config.json                 { token }
  flows/<flowId>.json         flow definition + step lastRun + memory + chat session ids
  chats/<flowId>/<key>.json   messages (key = stepId | _flow | _global), last 300 kept
  runs/<flowId>/<runId>.json  run record with per-step events and outputs
```

Spec 09 replaces this layout with one self-contained folder per flow.

**Concurrency:** engine writes use read-modify-write (`updateFlow`), so a run updating `lastRun` never overwrites a concurrent UI edit. The UI's `PUT /api/flows/:id` preserves the server-managed fields (`memory`, `lastRun`, `chatSessionId`, `chatContextHash`).

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `4317` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. `0.0.0.0` exposes only `/api/ext` remotely (spec 08). |
| `AFS_DATA` | `./data` | Data directory |
| `AFS_MAX_PARALLEL` | `2` | Concurrent steps within a level |
| `CLAUDE_BIN` | auto | Path to the Claude Code binary |
| `NODE_ENV=production` | — | Serve the built `dist/` instead of Vite middleware |

**Corporate TLS proxy:** `npm install` needs `NODE_OPTIONS=--use-system-ca`.

## Acceptance criteria
- `npm start` serves the UI at `http://127.0.0.1:4317`, with no API key configured.
- Running any AI step shows `init` (model + MCP servers), reasoning, tool calls/results and the final token usage.
- Killing the browser does not stop a run. Reopening shows its state from `data/`.
