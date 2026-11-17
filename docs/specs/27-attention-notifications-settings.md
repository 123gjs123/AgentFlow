# 27 · 🔔 Necesita atención, notificaciones de Windows y ⚙ Configuración

Status: Implemented (2026-11-17). Verified by `test/e2e/21-attention-notify.test.mjs` and `test/e2e/22-ui-attention.test.mjs`.

## Origin

The user shared a team dashboard design ("Agent Floor") and asked an adversarial reviewer, an architect and a UX/UI designer to discuss what fits Agent Flow Studio, then implement the best proposal.

Real pains that week:
- A run waited at a break while the user was elsewhere.
- A step failed with a misleading error.
- Tokens lived in a `.env` file.
- The user asked for "una pantalla de configuración".

Two findings in the code:
- The client dropped every WebSocket event from flows that were not open (`App.jsx`), so nothing in another flow was visible.
- An in-app inbox does not help if nobody is looking at the browser.

## Decisions

| # | Decision | Why |
|---|---|---|
| A1 | A server-side **attention list** (`server/attention.js`) covering ALL flows. It has four kinds: **break** (any trigger, from `engine.pausedRuns()`), **run_failed**, **quarantine** and **blocked** (missing credentials, which is a cheap local check, plus requirements read only from the cached preflight via `cachedPreflight()`, which never probes the network). `GET /api/attention` returns it, and the WebSocket event `attention.changed` carries the full list plus the `added` ids. | Seen from any flow; survives a reload; the same source feeds the toasts, the 🔔 count, the tab title and the desktop notifications. |
| A2 | **run_failed** is kept in memory per flow and fed by `run.finished`, with one run file read per finished run. It is built from disk only once at boot. Relevant failures are full runs and non-manual single steps (schedule, API) ending in error, timeout or interrupted. Only a later **complete** run that succeeds clears it; stopped runs and manual single-step tests change nothing. The cause is a plain-language sentence per code (MCP_UNAVAILABLE, CREDENTIAL_MISSING…), never the step input or output. | Adversarial review: re-reading run histories on every event would block the server with an hourly schedule. |
| A3 | **Navigation only** (D48). Each item's button opens the place: the flow and its break review, the run in Flujo › Ejecuciones, the quarantine banner, the "Antes de ejecutar" window, or Configuración › CLI / Credenciales. Nothing resumes, applies or trusts. "Marcar visto" stores `dismissed[id] = stateKey`, and the item counts again when its state changes (a new failure, a new pause). A dismissed break stays paused. A stale stateKey is rejected with 409. | Nothing changes behind the user's back; old news does not nag. |
| A4 | UI: **🔔 with a count** (red if something failed or is blocked); a **drawer** from the right (worst first, then oldest; "Vistos (n)"; Esc; Ctrl+Shift+A); **toasts bottom-right** for new items of other flows ("Abrir"; errors stay until closed); the **tab title** shows "(N) …"; options in the flow list get a ⏸ / ✗ / ⛔ prefix (native options cannot be styled). | From the UX review; reuses the existing tokens and `.req-result`-style severity borders. |
| A5 | **Windows notifications from the server** (`server/notify.js`), opt-in. They cover breaks and failures of any flow, including schedules and external triggers, even with no browser open. Rules: <br>• dedupe per item and state; <br>• **schedules** notify the first failure and the recovery ("Volvió a funcionar"), not every failing hour; <br>• per-flow minimum interval (breaks exempt); <br>• global cap of 6 per 10 minutes (breaks bypass it); <br>• while a toast is being shown, new ones are **combined** into one ("N avisos"), never dropped; <br>• a single summary at boot when the restart interrupted runs; <br>• text is the flow name, the step name and a generic cause, with control characters and `<>` stripped. <br>Implementation: PowerShell 5.1 + WinRT, a constant `-EncodedCommand` script, texts in environment variables, XML built with the DOM, PowerShell's AppUserModelID (nothing to register). Clicking opens `http://host:port/?flow=…&open=review` (never `?k=`). | The person is often not looking at the browser; no push service, no installer. |
| A6 | **⚙ Configuración** is one large modal with a left nav (same pattern as Ayuda) that reuses the existing panels. It replaces the 🔑 button: credential help now says "⚙ Configuración › Credenciales", and the old `afs:open-credentials` event opens that tab. Tabs: <br>• **Credenciales** (`CredentialsPanel`); <br>• **Integraciones** (external invocation and token); <br>• **Claude Code CLI**, an installation check from `GET /api/system/check`: CLI version, session (subscription vs API key), MCP connectors loaded vs. the ones the open flow uses (with how to fix), TLS/proxy (Node system CA, `NODE_EXTRA_CA_CERTS` present, proxy configured as yes/no only) and a writable data folder; <br>• **Notificaciones** (toggle and "Probar notificación"); <br>• **De dónde salen los números** (5h/7d, tokens, "≈ US$ equiv. API" is an estimate, not a charge). | One place for what is global; honest numbers; a colleague installing the app sees what is missing. |
| A7 | Deferred: a cross-flow Monitor with a live feed, a totals strip, configurable alerts, chat proposals in the inbox, a Mattermost hook, the browser Notification API, a favicon dot, registering our own AppUserModelID, and the pixel-art office. | Scope before the presentation; the adversarial review judged them low value or duplicated. |
