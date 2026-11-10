# 08 — Security model

**Status:** Implemented. Per-flow tokens are proposed in spec 11.

## Threat model

The app runs **on the user's machine with the user's privileges**. It can run shell commands, JavaScript hooks and Claude with edit or terminal tools, and it can reach the user's Jira and Confluence through MCP. Whoever controls the API effectively controls the user's account and machine, so the main risks are:

1. A malicious **web page** in the user's browser calling the local API (CSRF, DNS rebinding).
2. Another **host on the network** calling the API.
3. A **leaked token** allowing an outside caller to trigger flows.
4. **Over-privileged steps** (e.g. edit and terminal access where read was enough).

## Controls

| Risk | Control |
|---|---|
| Network exposure | Binds to `127.0.0.1` by default. `HOST=0.0.0.0` is opt-in and exposes only `/api/ext`. |
| CSRF / cross-site calls | UI API (`/api/*`, excluding `/api/ext`): loopback client IP, `Host` header must be localhost, and `Origin` (if present) must be localhost. POST must be `application/json`, so browsers preflight it and cross-origin preflights fail. |
| DNS rebinding | The `Host` header check rejects rebinding hostnames. |
| WebSocket hijack | `/ws` accepts only loopback clients with a localhost Host/Origin. |
| External callers | Every `/api/ext` request needs the token, compared in constant time. The token can be rotated from the UI. The external API can **run and ask**, but it cannot create or edit flows, hooks or commands. |
| Over-privilege | Steps default to read-only. Tools outside `allowedTools` are denied by Claude Code, and the UI shows the denials. Templates and AI generation pick minimum access. |
| Hook code | Hooks are authored only in the local UI and run with user privileges. Treat imported flows as code (spec 09: imported hooks and commands need review). |
| Secrets in prompts | The token is never placed in prompts. Snippets mask it unless the user reveals it. |

## Known limitations
- The token is shared across all flows; spec 11 adds per-flow tokens.
- `?token=` in webhook URLs can end up in proxy logs. Prefer header auth where the caller supports it.
- There is no TLS. Use a reverse proxy or VPN for remote access.
