# 06 — External invocation (API, CLI, MCP, webhook)

**Status:** Implemented. Per-step invocation details are covered in spec 12.

## Summary

Flows can be invoked from outside the UI in four ways:
- From Claude Code or other agents, through an MCP server.
- From a terminal, script or CI, through the `afs` CLI.
- From any HTTP client.
- From webhook-only tools.

All four go through a token-protected external API.

## Requirements

| ID | Requirement |
|---|---|
| EXT-1 | `/api/ext/*` requires the token, sent as `Authorization: Bearer <t>`, `X-AFS-Token: <t>` or `?token=<t>`. The comparison is constant-time. |
| EXT-2 | Flows are addressable by **id or name** (case-insensitive). Steps are addressable by id or name. |
| EXT-3 | Runs can be synchronous (`wait=true`, returns the final result) or asynchronous (returns `runId` and a status URL). |
| EXT-4 | Callers can set flow variables per call (`vars`) and run a single step (`step`). |
| EXT-5 | For webhooks, a body without an `input` field is passed to the flow, pretty-printed, as its input. |
| EXT-6 | A run summary exposes `status`, per-step `{step, status, output, error}`, and `result`, which is the concatenated output of the sink steps (or of the single step). |
| EXT-7 | The token is shown and regenerated in the UI (Help → Invoke from outside). It is stored in `data/config.json`. |
| EXT-8 | The CLI and the MCP server start the app automatically if it isn't running. |
| EXT-9 | The CLI exits with code 1 when the run fails, so CI stages fail correctly. |

## HTTP API

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /api/ext/ping` | — | `{ok, app}` |
| `GET /api/ext/flows` | — | `[{id, name, description, vars, steps[{id,name,kind}]}]` |
| `POST /api/ext/flows/:flow/run` | `{input?, step?, vars?, wait?, timeoutSec?, source?}` or a raw payload; query `wait, step, source, timeoutSec` also accepted | async: `{runId, status:'running', statusUrl}` · sync: run summary |
| `GET /api/ext/flows/:flow/runs/:runId` | — | run summary |
| `POST /api/ext/flows/:flow/ask` | `{message, step?}` | `{answer, routedTo, status}`. Without `step`, it goes through the general-chat router. |

Example:

```bash
curl -X POST "http://127.0.0.1:4317/api/ext/flows/My%20flow/run" \
  -H "Authorization: Bearer $AFS_TOKEN" -H "Content-Type: application/json" \
  -d '{"input":"SBK-123","vars":{"issue":"SBK-123"},"wait":true}'
```

## CLI (`bin/afs.js`, `npm link` → `afs`)

```
afs list
afs run  <flow> [-i text | -f file | stdin] [-s step] [--var k=v]... [--no-wait] [--json] [--timeout sec]
afs ask  <flow> "<question>" [--step S]
afs status <flow> <runId>
```

- **Environment:** `AFS_URL` (default `http://127.0.0.1:4317`) and `AFS_TOKEN` (default: read from `data/config.json`).
- **Output:** per-step progress goes to stderr and the final result to stdout.

## MCP server (`bin/mcp.js`)

A newline-delimited JSON-RPC server over stdio. It handles `initialize`, `ping`, `tools/list` and `tools/call`.

| Tool | Arguments |
|---|---|
| `list_flows` | — |
| `run_flow` | `flow, input?, step?, vars?, wait? (default true), timeoutSec?` |
| `get_run` | `flow, runId` |
| `ask_flow` | `flow, message, step?` |

**Registration** (done by the user; the app never changes Claude config by itself):

```
claude mcp add agent-flows -s user -- node C:\path\to\agent-flow-studio\bin\mcp.js
```

## Webhook

```
POST http://<host>:4317/api/ext/flows/<flow>/run?token=<t>&source=webhook
```

The JSON payload (e.g. from Bitbucket or Jira Automation) becomes the flow input. The run trigger is `webhook`.

## Remote callers

- By default the server listens only on `127.0.0.1`.
- Starting it with `HOST=0.0.0.0` exposes **only `/api/ext`** to other machines, still with the token. The UI and the UI API keep rejecting non-loopback clients.
- Services that can't reach the machine (e.g. Bitbucket Cloud reaching a laptop) need a VPN, a tunnel or a reverse proxy. Exposing the app to the internet without one is discouraged.

## Acceptance criteria
- `afs run "<flow>" -i x` prints step progress and the result, exits 0 on success and 1 on failure.
- A request without a token gets 401. With a token and `wait=true`, it returns the run summary.
- A raw JSON webhook payload arrives as the flow input, with trigger `webhook`.
- From Claude Code with the MCP registered, "run flow X with input Y" calls `run_flow` and returns the result.
