# 17 — Step context box and integration helper

**Status:** Implemented with exceptions (accepted 2026-11-11). Acceptance: 19 of 23 criteria pass; 14 and 16 pass with accepted deviations; 10 is verified except the AI half (`willResend:false` after a chat turn: code reading); 12 (UI) is verified by code reading only. Not implemented: CTX-6 `summary: cached`, CTX-16 node hover, the "Datos" ↔ box links, the exact-request "Probar" of INT-10, the INT-13 p90 gate for Jira `wait`. Template and wizard defects T1–T11 and adversarial round-3 findings were fixed on 2026-11-11 (see "Round 3 fixes" at the end); `scripts/verify/int-templates.mjs` passes 49/49 including hostile flow names. Decisions: D21–D32 (design) and D33–D37 (acceptance) in `docs/DECISIONS.md`.

## Summary

Two gaps reported by the user:

1. **"What does this step actually know?"** A step's context is assembled at run time from eight or more places (role, task, context field, skill/agent file, access list, memory, variables, upstream outputs, output format, rules), plus whatever Claude Code adds by itself (CLAUDE.md, MCP tool definitions, skill listing). Today the only way to see it is the "Datos" tab, and only *after* a run. This spec adds a **Context box**: a live **preview** of the effective context of a step *before* running it, every part labelled by source, whether it reaches the model, and its size.
2. **"How do I call this from Jira / Jenkins?"** The "Invocar" tab shows static snippets. Users don't know which caller can reach a local server, how to pass the token safely, which idempotency key to use or how to get the result back. This spec adds an **Integration helper**: a wizard that takes the caller type plus a plain-language description and produces ready-to-paste code or config. Common callers use deterministic templates. Claude (local CLI) adapts a template to the description, and a linter checks every output. The wizard explains reachability, can dry-run the call, and shows when the first real call arrives.

## Goals
- A user can answer "what will this step receive and which tools can it use?" without running it and without paying tokens.
- The preview is **exactly** what the engine sends. It is produced by the same code, so it is never a separate approximation.
- A user can wire a Jira Cloud rule or a Jenkins pipeline to a flow in under 5 minutes, without reading spec 06, and without the token ever appearing in the generated code.

## Non-goals
- The app does not start, configure or ship a tunnel (ngrok, Cloudflare, Tailscale). It explains them and generates their config.
- No per-caller or scoped tokens in this spec (open question 1, security policy).
- The app does not edit Jira rules or Jenkins jobs through their APIs. It generates text the user pastes.
- No exact token count for the parts Claude Code adds by itself (base system prompt, MCP tool schemas). These parts are listed but not measured.

## Requirements

Priority: M = must, S = should, C = could.

### Context box (CTX)

| ID | Pri | Requirement |
|---|---|---|
| CTX-1 | M | **Single builder.** Extract the code that `engine.js` uses to build an AI step invocation (system prompt, user prompt, `--tools`, `--allowedTools`, permission mode, model, effort, agent, add-dirs) and a command step invocation (rendered command, `AFS_V<n>` env, stdin, `STEP_UPSTREAM*`) into one pure function, `buildStepInvocation(flow, step, sample)` in `server/prompt.js` or a new `server/invocation.js`. The engine and the preview both call it. It has no side effects: no `claude` process, no memory write, no Haiku summary, no run file. |
| CTX-2 | M | **Preview endpoint.** `POST /api/flows/:id/steps/:stepId/preview` (UI API) returns the rendered invocation split into labelled **sections** (see "Sections" below). The body may carry an unsaved `draft` (a partial step, merged over the stored step, never persisted), `target: run | chat` and `sample` (CTX-4). Response time is under 500 ms for a 10-step flow. |
| CTX-3 | M | **Section metadata.** Each section has `{id, label, source, origin, toModel, chars, tokensEst, text}`. `source` is the config field or file it came from (e.g. `step.role`, `flow.memory`, `skill:qa-test-architect`, `upstream:Leer ticket`). `toModel` is `system`, `user`, `cli` (a flag, not text), `claude-code` (added by Claude Code, not by us) or `none` (shown for understanding only, e.g. hooks or assertions). `tokensEst = ceil(chars / 4)`, labelled "≈". |
| CTX-4 | M | **Sample data.** `sample = {mode: 'ui' \| 'external', input?, vars?, runId?}`. `ui` (the default) resolves upstream like a UI run: the current-run data is missing, so the pinned output is used, then the last successful output, then nothing. `external` ignores pins, as spec 16 EXT-10 does: a pinned upstream shows "se ejecutará: la salida real no se conoce aún" with the last output as a sample. `input` defaults to the flow input of the step's last run. `runId` reproduces a past run: its input, `run.vars` and the upstream outputs of that run. Every upstream and reference reports `{step, source: run\|pinned\|lastRun\|none, fromRunId, at}`, using the same values as OBS-1. |
| CTX-5 | M | **Fidelity.** With `sample.runId = R` and the step config unchanged since R, `system` and `user` in the preview are byte-identical to `R.steps[step].inputView.system` / `.prompt` (except for `summary` input mode, CTX-6). `cli.tools` equals `inputView.tools`. |
| CTX-6 | M | **Summary input mode.** The preview never calls Haiku. If a previous run of this step stored summaries, they are reused and marked `summary: cached`. Otherwise the upstream section shows the raw text clipped to `maxChars`, with the flag `summary: pending` and the note "Se resumirá con Haiku al ejecutar (>1.500 caracteres)". In this case CTX-5 does not apply. |
| CTX-7 | M | **Definition card (agent / skill).** `definition = {kind, ref, found, name, description, path, source (user\|claude.ai\|plugin:x\|project), frontmatter{}, excerpt, lines}`. The excerpt is the body of the SKILL.md or agent .md, up to 40 lines, with frontmatter shown separately (`allowed-tools`, `tools`, `model`). A note states how it reaches the model. **Skill:** "Claude Code always lists the name and description. The body enters only when the step invokes the Skill tool, which the system prompt asks it to do." **Agent:** "The file body is the agent's system prompt (`--agent`). Our system prompt is appended. The tools are the agent's own, `--tools` is not applied." A missing ref gives `found:false` plus warning `SKILL_NOT_FOUND` / `AGENT_NOT_FOUND`. |
| CTX-8 | M | **Full definition file.** `GET /api/catalog/file?kind=skill\|agent&name=<ref>&flow=<id>` returns the whole file (max 50,000 chars). It only serves files listed by `listSkills` / `listAgents` for that flow's `cwd`. Any other path is not addressable (no `path` parameter exists). |
| CTX-9 | M | **Access card.** `cli = {model, effort, permissionMode, agent, tools, allowedTools, addDirs, args[]}`, where `args` is the exact argv without temp-file paths (`--append-system-prompt-file <tmp>` is shown as `--append-system-prompt-file <system>`). Plain-language lines for the user: "Herramientas integradas disponibles: Read, Grep, Skill (--tools)", "Pre-aprobadas: …", "Todo lo demás pedirá permiso y, al ejecutar sin interacción, se denegará (PERMISSION_DENIED, spec 16 VER-1)". |
| CTX-10 | M | **MCP servers.** `mcp = {servers:[{name, status}], probedAt}` comes from the last cached `system/init` (runs, chats or `POST /api/catalog/probe`). If nothing is cached, `mcp.servers = null` and the box offers "Comprobar" (calls the existing probe, which costs no model tokens). The note says MCP tools are not restricted by `--tools`: they depend on `allowedTools` and the permission mode. |
| CTX-11 | M | **Claude Code additions.** A section with `toModel: 'claude-code'` lists what Claude Code adds by itself and what we cannot measure exactly: the base system prompt, `~/.claude/CLAUDE.md` and `<cwd>/CLAUDE.md` (each with path and `chars` if the file exists), the skill listing, and the MCP tool definitions (not measured). The totals show `ours` (measured) separately from this section. |
| CTX-12 | M | **Warnings.** `warnings[] = {code, message, section?}`. Codes: `SKILL_NOT_FOUND`, `AGENT_NOT_FOUND`, `UNRESOLVED_REF` (`{{…}}` left as is), `NON_UPSTREAM_REF` (in a full run this step would fail, spec 16 OBS-2), `RAW_TEMPLATE` (a `{{{…}}}` placeholder; an external run would be rejected), `INVALID_SCHEMA`, `JSON_NO_SCHEMA` (info), `SECRET_IN_PROMPT` (a variable name matches `/token\|secret\|password\|apikey\|pwd/i`, or a value matches the external API token: it reaches the model), `LARGE_PROMPT` (ours > 100,000 chars), `UPSTREAM_TRUNCATED` (an upstream exceeds `maxChars`), `HOOK_MAY_CHANGE` (an `onStart` hook exists, so the preview cannot reflect what the hook does). |
| CTX-13 | M | **Non-model sections.** Shown with `toModel: 'none'`: timeouts (`timeoutSec`, flow `runTimeoutSec`), assertions (name, type, severity), hooks present (`onStart` / `onSuccess` / `onFailure`), pin state, `allowDenials` / `allowEmpty`. This lets the box answer "what happens around the model call". |
| CTX-14 | S | **Chat view.** With `target: 'chat'` the preview returns the step chat's static system prompt (`stepChatSystem`), the `<step-context>` block (`stepContextBlock`) with its hash, and `willResend: bool`. `willResend` compares that hash with the hash the chat session last saw (spec 04 CHAT-2). The `<related-memory>` section is described ("hasta 6 hechos de otros steps según tu mensaje") but empty, because it depends on the message. |
| CTX-15 | S | **Compare with last run.** If the step has a `lastRun` with `inputView`, the box offers a line diff between the preview (with `sample.runId = lastRun.runId`) and what was sent. The diff shows whether config changes since that run alter the prompt. |
| CTX-16 | C | **Node hover.** Hovering a node for 600 ms shows a compact card with kind and ref, access summary, input mode with upstream count, memory count and the ≈ tokens of our part. The card uses the preview from the last cache, or no numbers if nothing is cached. |

#### Sections (AI step, `target: run`), in prompt order

| id | label (UI, Spanish) | source | toModel |
|---|---|---|---|
| `header` | Encabezado y tipo | step.kind, ref, file path | system |
| `skillHint` | Instrucción de usar la skill | step.skillRef | system |
| `role` | Rol / cómo trabaja | step.role | system |
| `context` | Contexto (renderizado) | step.context + resolved refs | system |
| `memoryStep` | Memoria del step | step.memory | system |
| `memoryFlow` | Memoria del flujo | flow.memory | system |
| `outputFormat` | Formato de salida / schema | step.output | system |
| `rules` | Reglas de salida (fijas) | app | system |
| `task` | Tarea (renderizada) | step.task + resolved refs | user |
| `upstream` | Lo que recibe de steps anteriores (modo, por step) | edges + input.mode | user |
| `input` | Input del flujo | sample.input | user |
| `vars` | Variables | flow.vars ⊕ sample.vars | user |
| `definition` | Definición de la skill / agente | catalog file | claude-code |
| `claudeCode` | Lo que agrega Claude Code | CLAUDE.md, MCP, base | claude-code |
| `access` | Acceso y herramientas | cli | cli |
| `around` | Timeouts, aserciones, hooks, pin | step | none |

Command steps return `rendered`, `env[] {name, ref, value}`, `stdin`, `envUpstream` (sizes) and the sections `access`/`around`. They have no model sections.

### Integration helper (INT)

| ID | Pri | Requirement |
|---|---|---|
| INT-1 | M | **Wizard first.** The "Invocar" tab (flow panel) and Help → "Invocar desde fuera" open on a 3-step **Asistente de integración**: (1) caller, (2) what should happen, (3) result. The current static snippets stay below it, collapsed, as "Snippets rápidos". |
| INT-2 | M | **Caller catalog.** `GET /api/integrations/callers` returns 12 callers with `{id, label, location: cloud\|onprem\|local, secretStore, naturalId, canSetHeaders, maxWaitSec}`: `jira-cloud` (Automation "Send web request"), `jira-dc` (Data Center Automation), `jenkins-declarative`, `jenkins-scripted`, `github-actions`, `bitbucket-pipelines`, `gitlab-ci`, `powershell-task` (Windows Task Scheduler), `bash-cron`, `python`, `claude-mcp`, `webhook` (generic). |
| INT-3 | M | **Deterministic templates.** Each caller has a parameterised template in `server/integrations/templates/<id>.js`, so generation needs no AI. Inputs: flow (name, URL-encoded), optional step, input expression, vars mapping (caller expression to flow var), mode (`wait` \| `async-poll` \| `fire-and-forget`), timeouts, `source` (= caller id, so runs show the caller as trigger), idempotency key expression, base URL (INT-6). Output: `{files:[{name, language, content}], setup:[string], notes:[string]}`. `setup` covers where to paste the output and how to create the secret. |
| INT-4 | M | **Contract in every output.** Every generated call uses: `POST <base>/api/ext/flows/<flow>/run`; header `Authorization: Bearer <secret ref>`; `Content-Type: application/json`; `Idempotency-Key` built from the caller's natural id; body `{input, vars, step?, wait, timeoutSec?, deadlineSec?, source}`. In `wait` mode it handles 202 `timedOut` by polling `GET …/runs/:runId`. In `async-poll` mode it polls every 10 s until the status is final. It maps outcomes to exit codes as `afs` does (spec 16 EXT-14: 0 success, 1 error/stopped/interrupted, 3 timeout) and fails on non-2xx with the body's `code`. Callers on this machine (`local`, or a Jenkins agent here) use `afs run … --key … --json` instead of HTTP. |
| INT-5 | M | **Secrets.** The token is never written in generated output. Each caller uses its secret store: Jenkins `withCredentials([string(credentialsId: 'afs-token', variable: 'AFS_TOKEN')])`; GitHub `${{ secrets.AFS_TOKEN }}`; Bitbucket secured repository variable `AFS_TOKEN`; GitLab masked + protected variable; Jira the header value marked **Hidden**; PowerShell/cron/Python the environment variable `AFS_TOKEN` (the setup text explains `setx` vs Windows Credential Manager); MCP needs no token (reads `data/config.json`). `?token=` in the URL is used only for `webhook` callers that cannot set headers (`canSetHeaders:false`), with a warning that URLs end up in logs. |
| INT-6 | M | **Reachability.** The generation response includes `reachability = {status, explanation, options[]}`, computed from caller `location`, server `HOST` and `config.publicUrl`. Statuses: `ok-local` (same machine: 127.0.0.1); `ok-lan` (on-prem caller and `HOST=0.0.0.0`: use `http://<LAN-IP>:<port>`, check the firewall); `needs-host` (on-prem caller and `HOST` loopback: restart with `HOST=0.0.0.0`, or run the job on this machine); `ok-public` (cloud caller and `publicUrl` set: use it as base); `needs-tunnel` (cloud caller and no `publicUrl`). For `needs-tunnel`, options are offered in this order: (a) run the job on this machine, without exposing anything (Jenkins agent, GitHub self-hosted runner, Bitbucket self-hosted runner, GitLab runner here), with `afs`; (b) Cloudflare Tunnel with an ingress rule restricted to `^/api/ext/` (generated `config.yml`); (c) Tailscale Funnel / ngrok, with the same path restriction where the tool supports it; (d) invert the direction: the flow pulls from Jira on a schedule (spec 10 / flow schedule) instead of Jira pushing. Each option states what becomes exposed. `HOST=0.0.0.0` is never suggested for cloud callers. |
| INT-7 | M | **Forwarded requests are remote.** A request carrying any of `X-Forwarded-For`, `X-Forwarded-Host`, `Forwarded`, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP` or `Ngrok-*` gets the same treatment as a non-loopback client: UI API, static UI, dev middleware and WebSocket return **403**, and only `/api/ext/*` (with token) is served. Without this, a tunnel that rewrites `Host` to `localhost` would expose the tokenless UI API. Generated tunnel configs never rewrite the Host header. |
| INT-8 | M | **AI adaptation.** `POST /api/integrations/generate {flow, caller, description, options?, ai:true}` runs Claude through the local CLI: model Sonnet, `--tools ""`, no session persistence, counted by the REL-9 semaphore. The prompt contains the ext API contract (spec 06/16 excerpt), the flow's vars, steps and sink JSON schema if any, the caller's template output as grounding, the reachability result, and the rules from INT-4/INT-5. The answer is JSON `{files, setup, notes, assumptions, mapping:{input, vars, idempotencyKey, mode, resultTo}}`. The description drives mapping, trigger condition (e.g. the JQL / rule trigger for "ticket moves to QA in SBK") and result handling. |
| INT-9 | M | **Lint gate.** Every output, from a template or from AI, goes through `lintIntegration(files, ctx)`. Errors: `TOKEN_LITERAL` (the current token, or any 32+ char hex/base64 string next to `Bearer`), `WRONG_ENDPOINT` (path is not `/api/ext/flows/<existing flow>/run`), `NO_AUTH`, `UNKNOWN_FLOW`, `UNKNOWN_STEP`. Warnings: `NO_IDEMPOTENCY_KEY`, `UNKNOWN_VAR` (var not in `flow.vars`), `TOKEN_IN_URL`, `LOOPBACK_FROM_CLOUD` (cloud caller targeting 127.0.0.1/localhost), `NO_TIMEOUT`. If AI output has lint errors, it gets **one** correction turn with the errors. If errors remain, the files are shown with the errors on top and the copy buttons disabled (the deterministic template stays available). `POST /api/integrations/lint {flow, caller, files}` exposes the linter. |
| INT-10 | M | **Dry run.** `POST /api/ext/flows/:flow/run` accepts `dryRun: true` (body) or `?dryRun=1`. With a valid token it performs every pre-start check (flow/step exists, REL-2 raw template → 422, VER-3 invalid schema → 422, vars merge, Idempotency-Key length) and returns `200 {dryRun:true, ok, flow, steps:[names that would execute], vars, usedPins, idempotencyKey, warnings}`. It creates no run file and does not record the idempotency key. CLI: `afs run … --dry-run`. The wizard's **Probar** button sends the generated request's exact URL, headers and body (smart values replaced by sample values the user can edit) as a dry run, from the server to itself. |
| INT-11 | S | **Inbound call log.** The server keeps the last 50 `/api/ext/*` requests in memory: `{at, method, path, source, status, code, remoteIp, forwardedFor, userAgent, runId?}`. Bodies and tokens are never stored. `GET /api/integrations/inbound?since=` (UI API) returns them. The wizard's last step shows "Esperando la primera llamada…" and turns green when a request with the chosen `source` arrives. A 401 shows "llegó, pero sin token válido". |
| INT-12 | S | **Real test run.** After a successful dry run, "Ejecutar de verdad" sends the same request without `dryRun`. The button says it uses the subscription and runs any actions of the flow (e.g. Jira comments). |
| INT-13 | M | **Result return.** The wizard asks "¿Dónde debe quedar el resultado?" and generates accordingly. **Jira Cloud:** default `fire-and-forget` (async). The flow itself comments through the Atlassian MCP, because Jira's web request waits at most ~30 s and flows usually take minutes. The wizard checks for a final step that comments on Jira (template "Comentar en Jira") and offers to add one using `{{vars.issue}}`. Waiting for `{{webResponse.body}}` is offered only if the flow's last-10-run p90 duration is < 25 s. **CI (Jenkins/GitHub/Bitbucket/GitLab):** the caller waits (`wait`, or `async-poll` above 10 min), fails the stage through exit codes, and saves the summary as `afs-result.json` (artifact). Optional extra: the flow also comments on Jira. **Script/Python:** stdout result, exit code. **MCP:** the `run_flow` result. |
| INT-14 | S | **Public URL setting.** `config.publicUrl` (e.g. the tunnel hostname) is set from the wizard (`PUT /api/info/public-url {url}`; empty value clears it). It is used as the base URL for cloud callers. It is never auto-detected. |
| INT-15 | S | **Natural idempotency keys (defaults).** jira-cloud / jira-dc: `afs-{{issue.key}}-{{issue.updated.format("yyyyMMddHHmmss")}}`; Jenkins: `${BUILD_TAG}`; GitHub: `${{ github.repository }}-${{ github.run_id }}-${{ github.run_attempt }}`; Bitbucket: `$BITBUCKET_REPO_SLUG-$BITBUCKET_BUILD_NUMBER`; GitLab: `$CI_PROJECT_ID-$CI_PIPELINE_ID-$CI_JOB_ID`; cron/PowerShell: flow name + date to the minute; Python: argument or UUID; MCP: `idempotencyKey` argument when the caller provides one. The key can be edited in the wizard. |
| INT-16 | S | **Checklist.** Copying any generated file ticks the onboarding item "external invocation snippet copied" (spec 07 ONB-3). |

## UI

### Context box (step panel)
- **Placement:** a collapsible box **"Contexto"** pinned above the tab content of the step panel. It is visible on the **Config** and **Chat** tabs and hidden on Actividad, Datos, Memoria and Hooks. It is not a new tab: a tab would hide it while the user edits the fields that change it, which defeats the purpose. The open/closed state is remembered per browser (`localStorage`).
- **Collapsed (default):** one line of chips, e.g. `Skill qa-test-architect · Acceso: Leer Jira (Read, Grep, Skill) · Recibe: json de 2 steps · Memoria 4+2 · ≈ 3.1k tokens (+ Claude Code) · ⚠ 1`.
- **Expanded:** max 50% of panel height, scrollable. One row per section: label, source chip (`step.role`, `flow.memory`, `skill file`, `upstream: Leer ticket · 📌 fijado`), destination chip (`→ system`, `→ user`, `flag CLI`, `lo agrega Claude Code`, `no va al modelo`) and `≈ tokens`. Each row expands to show its text. The definition card has "Ver archivo completo" (CTX-8, read-only modal). Warnings appear at the top. A sample selector shows "Datos de ejemplo: como en la UI / como ejecución externa / ejecución r_… / input: [ ]". Buttons: "Ver prompt completo" (modal with system + user + argv, each copyable) and "Comparar con última ejecución" (CTX-15).
- **Chat tab:** the same box with the toggle `Ejecución | Chat` set to Chat. It shows the chat system prompt, the `<step-context>` block and "se reenviará completo en el próximo mensaje: sí/no".
- **Sync:** the box calls the preview with the current **unsaved** draft, 400 ms after the last keystroke, and again after save, pin/unpin, memory change and edge change. It shows "actualizando…" while the request is in flight and never blocks typing.
- **Relation to "Datos":** "Datos" stays the immutable record of **what was sent** in a past run. The box shows **what would be sent now**. "Datos" adds a link "Ver previsualización actual", and the box links "Ver lo enviado en la última ejecución".

### Integration helper (flow panel → Invocar)
1. **Caller:** a card grid (the 12 callers in INT-2) and a free-text field "Describe desde dónde y cuándo se llama" (e.g. "cuando un ticket de SBK pasa a QA, ejecutar el flujo con la clave y comentar el resultado"). Optional: the step to run alone.
2. **Qué pasa:** mapping of input and vars (pre-filled from `flow.vars` keys; caller smart values offered in a dropdown, e.g. `{{issue.key}}`, `${GIT_COMMIT}`), mode (wait / async-poll / fire-and-forget), idempotency key, timeouts. A **reachability panel** (INT-6) with a status colour and the options. The public URL field is here.
3. **Resultado:** where the result goes (INT-13). Buttons **Generar** (template, instant) and **Adaptar con IA** (INT-8, shows a spinner and the usage when done). The output shows tabs per file, each with a copy button, the setup steps, notes, assumptions and lint results, then **Probar (dry run)**, **Ejecutar de verdad** and the inbound log indicator.

## Data / API additions

```jsonc
// data/config.json
"publicUrl": "https://afs.example.com"            // optional, INT-14
// in-memory only
inboundLog: [{ at, method, path, source, status, code, remoteIp, forwardedFor, userAgent, runId }]   // max 50
```

| Method & path | API | Purpose |
|---|---|---|
| `POST /api/flows/:id/steps/:stepId/preview` `{draft?, target?, sample?}` | UI | CTX-2..14. Returns `{kind, target, system, user, sections[], cli, mcp, definition, upstream[], refs[], warnings[], totals:{ours:{chars,tokensEst}, claudeCodeKnownChars}, chat?:{system, block, hash, willResend}, command?:{rendered, env[], stdin}}` |
| `GET /api/catalog/file?kind=&name=&flow=` | UI | CTX-8 |
| `GET /api/integrations/callers` | UI | INT-2 |
| `POST /api/integrations/generate {flow, caller, description?, options?, ai?}` | UI | INT-3/8. Returns `{files, setup, notes, assumptions?, mapping, reachability, lint:{errors[], warnings[]}, ai?:{used, model, usage}}` |
| `POST /api/integrations/lint {flow, caller, files}` | UI | INT-9 |
| `GET /api/integrations/inbound?since=` | UI | INT-11 |
| `PUT /api/info/public-url {url}` | UI | INT-14 |
| `POST /api/ext/flows/:flow/run` + `dryRun` | ext | INT-10 |
| `afs run … --dry-run` | CLI | INT-10 |

## Acceptance criteria

Same setup as spec 16: an isolated instance (`PORT=4319 AFS_DATA=<empty temp dir>`), UI API calls from loopback with JSON, ext calls with the token from `GET /api/info`, and fixtures created through `POST/PUT /api/flows` and deleted afterwards. Criteria marked (AI) use the subscription. All others start no `claude` process, which is checked by comparing the `claude.exe`/`node … claude` process list before and after.

**Context box**
1. **CTX-2/3 sections.** Role step with role, context `Ticket {{vars.issue}}`, step memory (2 items), flow memory (1), JSON output with schema, flow var `issue=SBK-1`, upstream command step A with last output `hola`. Preview → sections `header, role, context, memoryStep, memoryFlow, outputFormat, rules, task, upstream, input, vars, claudeCode, access, around` are present. `context.text` contains `Ticket SBK-1`. `upstream` has `source:"lastRun"` for A. Every section has `toModel`, `source` and `chars>0` (except empty ones, which are omitted). `totals.ours.chars` equals `system.length + user.length`.
2. **CTX-2 draft not persisted.** Preview with `draft:{task:"Revisa {{vars.issue}} YA"}` → `user` contains `Revisa SBK-1 YA`. `GET /api/flows/:id` afterwards shows the old task. No run file is created and memory is unchanged.
3. **CTX-5 fidelity (AI, 1 Haiku call).** Run the step from criterion 1 (model haiku) as a single step. Then preview with `sample.runId=<that run>` → `system === inputView.system`, `user === inputView.prompt`, `cli.tools === inputView.tools`.
4. **CTX-4 pins.** Pin A with `{output:"PINNED"}`. Preview with `mode:"ui"` → upstream A `source:"pinned"`, text contains `PINNED`. With `mode:"external"` → A `source:"lastRun"`, the note "se ejecutará" is present, text contains `hola`.
5. **CTX-6 summary.** Input mode `summary`, A's last output 3,000 chars, no cached summary → upstream flag `summary:"pending"`, and the preview starts no `claude` process.
6. **CTX-7/8 definition.** Skill step with an existing skill → `definition.found`, `path` ends in `SKILL.md`, `excerpt` ≤ 40 lines, `description` non-empty. `GET /api/catalog/file?kind=skill&name=<it>` returns the file. `name=../../data/config` → 404. Skill step with `skillRef:"nope"` → `found:false`, warning `SKILL_NOT_FOUND`.
7. **CTX-9 access.** Role step with access list `Read Grep mcp__atlassian__getJiraIssue` → `cli.tools` equals the built-ins of that list (spec 16 VER-1 / D14), `cli.allowedTools` contains the MCP tool, and `args` contains `--tools` and no temp path. Agent step → `cli.tools` is null and the note says the agent's tools apply.
8. **CTX-12 warnings.** Unconnected step C whose task has `{{steps.A.output}}` → `NON_UPSTREAM_REF`. Task with `{{steps.Nope.x}}` → `UNRESOLVED_REF`. Var `jiraToken` → `SECRET_IN_PROMPT`. Command `echo {{{input}}}` → `RAW_TEMPLATE`. Schema `{"type":"objekt"}` → `INVALID_SCHEMA`. Step with `onStart` hook → `HOOK_MAY_CHANGE`.
9. **Command step.** `Write-Output {{vars.issue}}` → `command.rendered` contains `$env:AFS_V0`, `env[0].value == "SBK-1"`, and no section has `toModel` `system` or `user`.
10. **CTX-14 chat.** `target:"chat"` → `chat.block` starts with `<step-context>` and `chat.hash` equals the sha1 of its body. After one chat turn (AI), `willResend` is `false`. After editing the role it is `true`.
11. **Performance.** 10-step flow, preview of the last step: p95 of 20 calls < 500 ms.
12. **UI.** With the Config tab open, typing in "¿Qué hace?" updates the box text within 1 s, without saving. The collapsed chips show the ≈ tokens. The box is visible on Config and Chat and absent on Datos. "Comparar con última ejecución" shows no diff right after a run and a diff after editing the task.

**Integration helper**
13. **INT-2.** `GET /api/integrations/callers` → 12 entries with the ids listed in INT-2, each with `location` and `secretStore`.
14. **INT-3/4/5 Jenkins.** `generate {caller:"jenkins-declarative", options:{mode:"wait", vars:{build:"${BUILD_NUMBER}"}}}` → the Jenkinsfile contains `withCredentials`, `Idempotency-Key`, `${BUILD_TAG}` and `/api/ext/flows/<encoded flow>/run`, and does not contain the token. `lint.errors` is empty.
15. **INT-3 every caller.** For each of the 12 callers, template generation returns ≥1 file with lint errors empty. YAML outputs (GitHub, Bitbucket, GitLab, Cloudflare config) parse with a pure-JS YAML parser in `scripts/verify/int-templates.mjs`. The Jira output's body is valid JSON after replacing `{{…}}` smart values with sample strings.
16. **INT-4 executable templates.** With `AFS_TOKEN` set to the instance token and a fixture flow (one command step), the generated PowerShell, bash (Git Bash + curl) and Python scripts exit 0. With the step changed to `exit 1` they exit 1. With `deadlineSec:2` on `Start-Sleep 30` they exit 3. A second run with the same idempotency key returns the same `runId`.
17. **INT-6 reachability.** `HOST` loopback: `jira-cloud` → `needs-tunnel`, first option "run on this machine" is absent for Jira (not applicable), the Cloudflare option includes `^/api/ext/`, and no option contains `HOST=0.0.0.0`. `jenkins-declarative` with location `onprem` → `needs-host`. With location `local` → `ok-local`, and the code uses `afs run`. After `PUT /api/info/public-url {url:"https://x.example"}`, `jira-cloud` → `ok-public` with base `https://x.example`.
18. **INT-7 forwarded.** From loopback: `GET /api/flows` with `X-Forwarded-For: 1.2.3.4` → 403. `GET /` with `CF-Connecting-IP` → 403. WebSocket upgrade with `X-Forwarded-For` → closed. `GET /api/ext/ping` with token and `X-Forwarded-For` → 200. Without headers, `GET /api/flows` → 200.
19. **INT-9 lint.** `POST /api/integrations/lint` with a file containing the real token → `TOKEN_LITERAL`. A path `/api/ext/flows/Nope/run` → `UNKNOWN_FLOW`. A `jira-cloud` caller with `http://127.0.0.1` → `LOOPBACK_FROM_CLOUD`. A file without `Idempotency-Key` → warning.
20. **INT-8 AI (AI).** Description "cuando un ticket de SBK pasa a QA, ejecuta el flujo con la clave y comenta el resultado" for `jira-cloud` → `lint.errors` empty, `mapping.vars` maps a flow var to `{{issue.key}}`, `mapping.mode == "fire-and-forget"`, `mapping.resultTo` mentions the flow commenting, `setup` mentions the trigger "Issue transitioned" to QA, and `ai.usage.inputTokens > 0`.
21. **INT-10 dry run.** `run` with `dryRun:true` and `Idempotency-Key: k9` → 200 `{dryRun:true, ok:true, steps:[…]}`. The number of run files is unchanged. A real run with key `k9` afterwards starts a new run (not a replay). Raw-template fixture with `dryRun` → 422 `RAW_TEMPLATE_EXTERNAL`. No token → 401. `afs run <f> --dry-run` exits 0 and prints the steps.
22. **INT-11 inbound.** After a 401 call and a 200 dry run with `source:"jira"`, `GET /api/integrations/inbound` lists both with status, `source`, `remoteIp`, and no token or body fields.
23. **INT-13.** `jira-cloud` generation for a flow without a Jira-comment step → `notes` include "añade un step final 'Comentar en Jira'". `github-actions` with `mode:"wait"` → the workflow uploads `afs-result.json`.

## Implementation notes (2026-11-11)

Files: `server/context.js` (`previewStep`, `definitionFile`), `server/prompt.js` (`systemSections` / `userSections`, used by the engine and the preview), `server/claude.js` (`buildArgs`, shared), `server/integrations.js` (callers, reachability, templates, lint, AI adaptation, inbound log), `server/index.js` (endpoints, `dryRun`, inbound logging, `PUT /api/info/public-url`, forwarded-header guard), `bin/afs.js` (`--dry-run`), `client/src/Context.jsx`, `client/src/Integrations.jsx`, wired in `Panels.jsx` and `Help.jsx`.

Deliberate differences from the text above (accepted, DECISIONS D33–D37):
- CTX-1: there is no single `buildStepInvocation`. The shared pure pieces are `systemSections` / `userSections` (prompt.js), `cliOptions` (engine.js) and `buildArgs` (claude.js). Fidelity is proven by criterion 3 (byte-identical).
- INT-3: all templates live in `server/integrations.js`, not one file per caller. CI and script callers share two stdlib clients, `afs_call.py` and `afs-call.ps1`, that hold the HTTP contract (endpoint, `Idempotency-Key` header, 202/poll, exit codes). Generated pipeline files only pass arguments. Criterion 14 is met through the client, not by literals in the Jenkinsfile. `bash-cron` calls `afs_call.py` (python3), not curl.
- INT-4: `powershell-task` (location local) calls `127.0.0.1` over HTTP. `afs run` is offered in the notes.
- INT-7: of the `Ngrok-*` family only `Ngrok-Trace-Id` is checked. Real ngrok traffic also carries `X-Forwarded-For`, so it is still blocked.

Not implemented: CTX-6 `summary: cached` (always `pending`); CTX-16 hover card; the links "Ver previsualización actual" / "Ver lo enviado en la última ejecución"; the sample "input: [ ]" field in the box; INT-13 p90 < 25 s gate before offering Jira `wait`; INT-10 "Probar" sends a body rebuilt from `mapping` without the `Idempotency-Key` header, not the exact generated request.

Open defects (fix before calling the spec done):

| # | Where | What breaks | Fix |
|---|---|---|---|
| T1 | `integrations.js` GitHub/Bitbucket `name:` line | Flow name with `": "` (e.g. `Smoke: QA`) produces invalid YAML (`mapping values are not allowed here`). | Emit `name: ${JSON.stringify('Ejecutar flujo ' + flowName)}`. |
| T2 | Bitbucket/GitLab `location: local` script line `- afs run …` | A plain scalar: `": "` breaks the YAML, and `" #"` in the flow name starts a comment, cutting off `--key …`. | Always use the `- >-` block form (already used for the remote variant), or JSON-quote the line. |
| T3 | Bitbucket `runs-on: [self.hosted, windows]` / GitLab Windows shell runner | Commands use bash syntax `$BITBUCKET_REPO_SLUG`, `$CI_PIPELINE_ID`. In PowerShell these are undefined variables, so the key becomes `-` / `--`, and every build after the first replays the first run (`idempotentReplay`). | Windows runner: use `$env:NAME`. Otherwise use a Linux shell runner (`linux.shell`) and keep bash syntax. |
| T4 | Jenkins (both), flow name with `'` | `bat '…"O'Brien"…'` and `powershell '''… -Flow 'O''Brien''' …'''` end the Groovy string early, so the Jenkinsfile does not compile. | Escape `'` → `\'` for Groovy single-quoted strings. For `'''` strings, pass the flow name in an `environment {}` variable (`AFS_FLOW`) and read `$env:AFS_FLOW` / `"$AFS_FLOW"`. |
| T5 | `lintIntegration` endpoint regex | `encodeURIComponent` leaves `'` unencoded, and the path regex stops at `'`, so a flow name with `'` gives a false `WRONG_ENDPOINT` for Jira/webhook and the copy buttons are disabled. | Encode `'` as `%27` in templates (`encodeURIComponent(n).replace(/'/g,'%27')`). |
| T6 | `afs_call.py`, `afs-call.ps1` on 409 `IDEMPOTENCY_CONFLICT` | Exit 0: a CI retry with changed parameters passes green without running. INT-4 says to fail on non-2xx. | Exit 2 with the message. |
| T7 | `afs-call.ps1` on PowerShell 7 (`pwsh`) | `$_.Exception.Response.GetResponseStream()` does not exist in PS 7. A 401/404/422 throws, and the script exits 1 ("flow failed") instead of 2 with the code. | Read `$_.ErrorDetails.Message` (works in 5.1 and 7), or use `-SkipHttpErrorCheck` on PS 7. |
| T8 | `ejecutar-flujo.sh` (bash-cron) on Windows Git Bash | `python3` resolves to the Microsoft Store alias: exit 49 "Python was not found". Verified on this machine; it works when `python3` is a real interpreter. | `PY=$(command -v python3 >/dev/null && python3 -c '' 2>/dev/null && echo python3 || echo python)`. |
| T9 | Wizard + checklist | (a) The inbound indicator waits for `source = caller.split('-')[0]`, but `jira-dc` sends `jira-dc` and `powershell-task` sends `tarea`, so it never turns green for them. (b) Copy sets `localStorage['afs.extCopied']`, but the checklist reads `afs.didExternal`, so INT-16 never ticks. | (a) Send `source = caller id` everywhere (INT-3) and match on it. (b) Use one key. |
| T10 | ext `run` with `dryRun` and an already-used `Idempotency-Key` | Returns the previous run (`idempotentReplay:true`), not a dry-run answer. | Evaluate `dryRun` before the idempotency replay (still without recording the key). |
| T11 | Low | `afs_call.py`: a connection error prints a traceback and exits 1 (should be 2 with a message). Tailscale option text contains a literal `PORT`. GitHub template triggers on every `push` to `main` (runs the flow and uses the subscription on each push); default to `workflow_dispatch` only. | As described. |

Acceptance evidence (isolated instance `PORT=4319`, empty `AFS_DATA`, 2 AI calls: 1 Haiku, 1 Sonnet):

| # | Result | Evidence |
|---|---|---|
| 1, 2, 4, 6–9, 11, 13, 17, 19, 22, 23 | PASS | Implementer script re-run by the PO: 21/21 (perf p95 4 ms; skill `definition` from the real catalog, `../../data/config` → 404). |
| 3 | PASS (Haiku) | Run `r_099e7a72` single step `Analizar`: system 967/967 chars, user 157/157 chars, byte-identical; `cli.tools` = `inputView.tools` = `Read,Grep,ToolSearch`. |
| 5 | PASS | A output 3,000 chars, input mode `summary` → `summary:"pending"`, warning `SUMMARY_PENDING`, answer in 3 ms (no model call possible). |
| 10 | PASS (non-AI part) | `chat.block` starts with `<step-context>`, `hash` = sha1 of the body; editing the role changes the hash, `willResend:true`. The `false` case after a chat turn is checked by code reading only (engine.js:791/850 store the hash from the same `stepContextBlock`). |
| 12 | Code reading | `Panels.jsx:118` renders the box only on Config/Chat; `Context.jsx:46-58` previews the unsaved step 400 ms after a change; `:75` chip "≈ N tokens"; `:78-85` diff against the last run. Not exercised in a browser. |
| 14 | PASS with deviation | `withCredentials`, `${BUILD_TAG}`, no token, lint clean. `Idempotency-Key` and `/api/ext/flows/<flow>/run` live in `afs_call.py` / `afs-call.ps1`, not in the Jenkinsfile (D34). |
| 15 | PASS | `scripts/verify/int-templates.mjs`: 25/25 for all callers (remote and local) incl. YAML, Jira JSON, PowerShell parser, `py_compile`, `bash -n`. With the hostile flow name `Smoke: QA #1 'x'`: 11 failures, see T1, T2, T5. |
| 16 | PASS with deviation | PowerShell and Python clients: success 0, `exit 1` → 1, `deadlineSec:2` on `Start-Sleep 30` → 3, same key → same `runId`. bash-cron passes only with a real `python3` on PATH (T8). |
| 18 | PASS | `X-Forwarded-For` on `/api/flows` → 403; `CF-Connecting-IP` on `/` → 403; WS with XFF → socket destroyed; `/api/ext/ping` + token + XFF → 200; plain `/api/flows` → 200. |
| 20 | PASS (Sonnet) | 11 s; lint clean; `vars.issue = {{issue.key}}`; mode `fire-and-forget`; `resultTo` says the flow comments; setup says "Issue transitioned … To status = QA", JQL `project = SBK`; 3,967 input tokens; no token in output. |
| 21 | PASS | Dry run with key `k9` → 200; run files on disk 0 → 0; `?dryRun=1` → 200; real run with `k9` → new run; raw template → 422; no token → 401; `afs run po17-int --dry-run` → exit 0, "se ejecutarían 1 step(s): Uno". |

## Open questions (non-blocking)
1. **Per-caller tokens** (one revocable token per integration, scoped to flows). Useful once a tunnel is in place, but it changes the security model in spec 08. Escalate to the user before scheduling.
2. Confirm in a real Jira Cloud site: the exact web request timeout (assumed ~30 s), the "Hidden" header option, and that `{{issue.updated.format(...)}}` renders in headers. Adjust the template if not.
3. Calibrate the 4 chars/token estimate against `usage.inputTokens` from OBS-3 once 20+ runs exist. The box could later show "real last run: N tokens" next to the estimate.

## Round 3 fixes (2026-11-11)

Adversarial review round 3 and the product verification found defects in the generated code (T1–T11 and others). The design changed so that whole classes of defects cannot happen, instead of patching each template:

- **No caller data through a shell.** Caller expressions are written as `{ENV_NAME}` placeholders (`{BUILD_TAG}`, `{GIT_COMMIT}`, `{NOW}`) that the shared clients (`afs_call.py`, `afs-call.ps1`) expand from the environment themselves. `${X}`, `$X`, `%X%` and `$env:X` typed in the wizard are converted. GitHub `${{ … }}` expressions go to the step's `env:` block, never into `run:`, which prevents Actions script injection. Command arguments are literal: bash `'…'`, PowerShell `'…'`, Groovy `'''…'''` with backslashes doubled. YAML uses literal `|` blocks and JSON-quoted names.
- **Flows and steps by id** in every generated URL and argument. Names with `'`, `"`, `:`, `#` or accents no longer break YAML, Groovy, Windows codepages or the lint.
- **Local runners on Windows** (Jenkins agent, GitHub/Bitbucket/GitLab self-hosted) use `afs-call.ps1` against 127.0.0.1, instead of `afs run` with bash syntax that left the idempotency key constant.
- **Clients.**
  - Exit 2 on 409 IDEMPOTENCY_CONFLICT, on connection errors and on repeated poll errors (no traceback).
  - `--var` without `=` is an error.
  - PowerShell client: TLS 1.2; `ErrorDetails` (works on PowerShell 7); `ReadAllText` for input files; UTF-8 output without BOM; vars as `-VarsJson` (works through `-File`).
  - The bash wrapper uses `python3` or, if missing, `python`.
- **Jira:** smart values mapped by the user get `.jsonEncode` automatically.
- **Lint.**
  - New `DANGEROUS_COMMAND` check: `| sh`, Invoke-Expression, base64 decoding, `set -x`, printing env/token, mass delete.
  - New `FOREIGN_HOST` check: any host other than the chosen base.
  - Also catches a token in `X-AFS-Token` or the query string.
  - Setup steps and notes are linted too.
  - The token is redacted from the description before it reaches the model.
- **Preview fidelity.**
  - Summary mode shows the upstream text; the `pending` flag is metadata only.
  - Upstream steps that will run fresh are labelled as the engine labels them. Their sample is the last output, flagged in metadata.
  - Hook-skipped outputs are included in run samples.
  - The box accepts a test input.
- **Server.**
  - Dry run is evaluated before the idempotency check and returns variable names only.
  - `GET /api/ext/flows` returns variable names only, because values may be secrets.
  - The public URL must be `https://`, parsed with `URL` and stored as origin plus path.
  - `source` = caller id, so the wizard's "first call arrived" indicator works for every caller.
  - The GitHub template triggers on `workflow_dispatch` only.

Verification after the fixes:
- `scripts/verify/int-templates.mjs`: 49/49, with hostile names, YAML parse, PowerShell parser, `py_compile`, `bash -n`.
- Spec 17 suite: 21/21, plus 22/22 including the Sonnet adaptation before the rewrite.
- Spec 16 regression: 30/30. Round-2 regression: 13/13.

