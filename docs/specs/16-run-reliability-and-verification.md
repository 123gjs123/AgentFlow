# 16 — Run reliability, observability and step verification

**Status:** Implemented (hardening round 1, accepted 2026-11-10) with exceptions: REL-9 `queued` is an event, not a persisted step status; REL-10 ignores rate-limit `resetsAt` (fixed 30 s / 120 s backoff); EXT-14 a malformed JSON body returns an HTML 400 page (with stack trace) instead of `{error, code}`; SEC-1 verified only through the Host-header guard (a non-loopback client IP was not exercised). Requirements marked *(Deferred)* are out of this round. See "Implementation notes".

## Summary

Specs 06 and 15 made flows callable from outside (API, CLI, MCP, webhook) and gave steps structured handoffs. An adversarial review found that these runs are not yet safe to depend on from CI or from another agent:

- values rendered into command steps reach PowerShell unescaped (`engine.js:211`, `prompt.js:39-46`), so an external `input` or `vars` value can execute code;
- external `vars` are written into the flow file (`index.js:64`) and every step re-reads the flow (`engine.js:337`), so concurrent runs see each other's variables;
- runs live only in memory until a step finishes; after a restart they stay `running` forever;
- there are no timeouts on `claude`, shell steps or the run;
- pinned steps make an external run green on frozen data;
- the MCP `run_flow` tool never sets `isError` for a failed run and drops `json` (`mcp.js:41-47,83`);
- the JSON correction retry ignores the second attempt's error and keeps the first attempt's text (`engine.js:255-261`);
- the schema validator silently ignores unsupported keywords and invalid schemas.

This spec makes a run **isolated, bounded, durable, honest about its inputs, and verifiable**, and exposes that to the three external callers (CI, scripts, agents via MCP) and in the existing step tabs.

## Goals
- An external run cannot inject shell code through `input` or `vars`, and cannot change the flow definition.
- Every run ends in a terminal state, even after a crash, hang or restart.
- A caller can tell exactly which data each step consumed (fresh, pinned, or from an older run).
- A step can declare what "correct output" means (schema, assertions) and the run fails when it is not met.
- CI gets distinct exit codes for success, failure and timeout; MCP clients get `isError` and structured results.
- Per-step cost, tokens, turns and duration are visible.

## Non-goals
- Multi-user, remote UI, API keys: still single user, local machine, the user's Claude subscription via the `claude` CLI.
- Durable resume of an interrupted run from the failed step (a new run is started instead).
- Full JSONPath; paths use the existing `a.b.0.c` syntax from spec 15.

## Requirements

Priority: **M** = Must (this round), **S** = Should (this round), **D** = Deferred.

### Reliability (REL)

| ID | Pri | Requirement |
|---|---|---|
| REL-1 | M | **Shell-safe templates.** In `command` steps, every `{{…}}` placeholder (`input`, `upstream`, `vars.*`, `steps.*`) is **not** spliced into the command text. Each value is put in an environment variable `AFS_V<n>` (n from 0) and the placeholder is replaced by a reference to it: PowerShell `$env:AFS_V0`, bash `"$AFS_V0"` (with quotes), cmd `!AFS_V0!` (cmd is launched with `/v:on`, so expansion happens after parsing). The rendered command shown in "Datos" displays the reference plus the value next to it. |
| REL-2 | M | **Raw opt-out.** `{{{ … }}}` (triple braces) splices the value verbatim, for authors who template command fragments on purpose. An external run (`/api/ext`, CLI, MCP, webhook) is rejected with **422** before starting if any command step that would execute uses a raw placeholder on `input`, `upstream`, `steps.*`, or on a variable present in the request `vars`. UI runs log a warning event per raw placeholder. |
| REL-3 | M | **Per-run variables.** `run.vars = {...flow.vars, ...request.vars}` is computed once at start and stored in the run. Request `vars` are never written to the flow file. Templates, hooks (`ctx.vars`) and prompts read `run.vars`. This changes spec 06 EXT-4 behaviour: vars passed by a caller no longer persist. |
| REL-4 | M | **Flow snapshot.** At run start the flow (steps, edges, vars, cwd) is deep-copied into memory and used for the whole run; edits made while the run is active do not affect it. The run file stores `flowSnapshotHash` (sha256 of the snapshot JSON) and `flowUpdatedAt`. |
| REL-5 | M | **Durable runs.** The run file is saved at run start, at each step start, at each step end, and at most every 5 s while a step emits events. At server startup every run file with status `running` (and every `step.lastRun` with status `running`) is set to `interrupted`, its running steps to `interrupted`, with `endedAt` = startup time and `error: "Servidor reiniciado durante la ejecución"`. |
| REL-6 | M | **Step timeout.** `step.timeoutSec` (default **900**, min 10, max 7200) applies to the `claude` process, shell process and correction turn of that step (the clock starts when the process starts, not while queued). On expiry the process tree is killed and the step ends with status `timeout`. Downstream steps are `skipped` and the run ends with status `timeout` (not `error`). |
| REL-7 | M | **Run deadline.** `flow.runTimeoutSec` (default **3600**), overridable per external call with `deadlineSec` (max 14400). On expiry the run aborts: running steps → `timeout`, not-started steps → `skipped`, run status `timeout`. `flow.runTimeoutSec` is added to the fields accepted by `PUT /api/flows/:id`. |
| REL-8 | M | **Kill the process tree.** Stop, cancel and timeout kill the whole tree. On Windows: `taskkill /PID <pid> /T /F`; elsewhere: kill the process group. Verified by no surviving child process (e.g. a `Start-Sleep` launched by the step). |
| REL-9 | M | **Global concurrency limit.** A process-wide semaphore caps concurrent `claude` processes (runs, step chats, general chat, router, summaries, judge) at `AFS_MAX_CLAUDE` (default **3**). A waiting step logs an event `{kind:'queued'}` until it acquires a slot (its persisted status stays `running`; a distinct `queued` status is deferred to round 2). Shell processes are not limited by this semaphore (only by `AFS_MAX_PARALLEL` per level, as today). |
| REL-10 | S | **Transient retries.** AI steps retry automatically on transient failures: rate limit / overloaded result, or the process exiting with no `result` message. Max **2** retries, backoff **30 s then 120 s** (*round 2:* use rate-limit `resetsAt` if earlier than 10 min away, else fail). No retry if the failed attempt performed detected actions (spec 15, write-type MCP calls) or file writes. Command steps retry on non-zero exit only if `step.retry.max > 0` (default 0), with `step.retry.backoffSec` (default 10, doubled each time). Assertion and schema failures are never retried by this mechanism. Each attempt is recorded in `attempts[]`. |

### External invocation (EXT)

| ID | Pri | Requirement |
|---|---|---|
| EXT-10 | M | **Pins ignored by default for external runs.** External full runs execute pinned steps unless the request sets `usePins: true`. UI runs keep today's behaviour (pins used). The summary lists `usedPins: [stepName]` (empty array when none). |
| EXT-11 | M | **Idempotency.** `POST /api/ext/flows/:flow/run` accepts header `Idempotency-Key` (1–200 chars). Same key + same flow + same body hash within 24 h → returns the existing run (`200`, body as for that call's `wait` mode, plus `idempotentReplay: true`); no new run starts. Same key with a different body → **409**. Keys are persisted in `data/idempotency.json` so they survive restart. |
| EXT-12 | M | **Cancel one run.** `POST /api/ext/flows/:flow/runs/:runId/cancel` → `{runId, status:'stopped'}`; **404** unknown run, **409** already finished. Also `afs cancel <flow> <runId>` and MCP tool `cancel_run {flow, runId}`. The UI API gets the same per-run route (`POST /api/flows/:id/runs/:runId/cancel`). |
| EXT-13 | M | **MCP results.** `run_flow` and `get_run` return `isError: true` when the run status is not `success` (including `running` past the wait, flagged as timed out), include the sink `json` as a fenced `json` block in the text, and return `structuredContent` = the run summary. `run_flow` accepts `usePins`, `deadlineSec`, `idempotencyKey`. |
| EXT-14 | M | **Exit codes and HTTP codes.** `afs run`: `0` success, `1` error/stopped/interrupted, `2` usage error, `3` timeout (run status `timeout`, or the wait elapsed while still running). Sync `wait=true` that elapses returns **202** with `timedOut: true` and the current summary. Errors: 400 malformed body, 401 token, 404 flow/step/run, 409 idempotency conflict or cancel of finished run, 422 rejected run (REL-2, VER-3 invalid schema at start), 500 internal. Every error body is `{error, code}` where `code` is a stable string (e.g. `RAW_TEMPLATE_EXTERNAL`, `IDEMPOTENCY_CONFLICT`). |
| EXT-15 | S | **Event polling.** `GET /api/ext/flows/:flow/runs/:runId/events?after=<seq>` → `{events:[{seq, stepId, step, kind, text?, name?, isError?, t}], next, done}` (max 500 per page; long text clipped to 2,000 chars). `afs run --follow` prints these as they arrive (to stderr). |
| EXT-16 | D | *(Deferred)* SSE stream `GET …/runs/:runId/stream`. Polling (EXT-15) covers CI and CLI; MCP clients cannot consume a stream inside one tool call anyway. |

### Observability (OBS)

| ID | Pri | Requirement |
|---|---|---|
| OBS-1 | M | **Provenance.** Each step run records `inputs: [{step, stepId, source: 'run'|'pinned'|'lastRun', fromRunId, at, viaRef: bool}]` for every upstream edge and every `{{steps.X…}}` reference resolved. Returned in the run summary per step and shown in "Datos". |
| OBS-2 | M | **Stale references fail full runs.** In a full run, a `{{steps.X…}}` reference to a step that is not a transitive ancestor (so it would resolve from a pin or an older run) makes the step fail with `code: NON_UPSTREAM_REF` before executing, unless `step.input.allowNonUpstream = true` (then it resolves as today and provenance says `lastRun`/`pinned`). Single-step runs are allowed and recorded. |
| OBS-3 | M | **Usage per step.** Each AI step run records `usage: {model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd, numTurns, durationMs, durationApiMs}` from the CLI `result` message (summed across correction turn and retries). Command steps record `durationMs` and `exitCode`. Every step records `skipReason` when skipped (`upstream_failed`, `pinned`, `hook`, `deadline`, `cancelled`). The run summary includes per-step `usage` and run `totals {costUsd, inputTokens, outputTokens, durationMs}`. `costUsd` is the CLI's API-equivalent figure, labelled informative (the subscription is not billed per call). |
| OBS-4 | M | **Statuses.** Step statuses: `running, success, error, timeout, stopped, skipped, interrupted` (`queued` deferred, see REL-9). Run statuses: `running, success, error, timeout, stopped, interrupted`. Summary per step adds `attempts`, `durationMs`, `error`, `code`. |

### Verification (VER)

| ID | Pri | Requirement |
|---|---|---|
| VER-1 | M | **Strict success for AI steps.** An AI step fails (`code: PERMISSION_DENIED`) if the CLI result reports ≥1 permission denial, unless `step.allowDenials = true`. Role and skill steps pass `--tools <built-ins from the access list>` in addition to `--allowedTools`, because `--allowedTools` only pre-approves and does not restrict (skill steps add `Skill`; agent steps keep their agent definition). Tool patterns with spaces such as `Bash(git status:*)` are kept intact. It fails (`code: EMPTY_OUTPUT`) if, after removing tags, output text is empty and there is no JSON, file or action, unless `step.allowEmpty = true`. Command steps keep "exit code is the contract". |
| VER-2 | M | **Real JSON Schema validator.** Replace `server/schema.js` with Ajv (pure JS, draft-07 and 2020-12, `allErrors`, `ajv-formats`). Error messages keep the `$.path: message` shape. |
| VER-3 | M | **Invalid schema is an error.** A schema that does not parse or does not compile fails the step with `code: INVALID_SCHEMA` (UI shows the compile error in Config when editing). An external run whose executable steps contain an invalid schema is rejected with 422 before starting. |
| VER-4 | M | **Correction turn fixed.** If the correction turn's process errors, the step fails with that error. If it succeeds, the step's `output` text and `json` come from the correction turn (not the first attempt). The correction turn is recorded as an attempt and counts toward usage and timeout. |
| VER-5 | M | **Assertions.** `step.assertions[]` run after schema validation and after `onSuccess`, on the final handoff. Types: `contains` / `notContains` `{value, caseSensitive?}`; `regex` `{pattern, flags?}` on output text; `json` `{path, op: exists|equals|notEquals|gte|lte|lengthGte|lengthLte|matches, value?}` on `json`; `command` `{command, shell?, timeoutSec?=60}` — output on stdin, `AFS_OUTPUT_JSON` env, pass on exit 0. Assertions and empty output never trigger a correction turn (only JSON/schema failures do). Each has optional `name` and `severity: error|warn` (default `error`). Any failing `error` assertion → step status `error`, `code: ASSERTION_FAILED`, downstream skipped. Results stored as `assertions: [{name, type, pass, severity, message, durationMs}]`. |
| VER-6 | S | **Judge assertion.** Type `judge` `{rubric, model?='haiku', threshold?}`: a separate `claude` call (no tools, no session persistence, counted by REL-9) gets the rubric and the output and must answer JSON `{pass, score?, reason}`. Pass if `pass === true` (and `score >= threshold` when set). Judge usage is added to the step's usage under `usage.judge`. |
| VER-7 | D | *(Deferred)* Per-flow "contract tests" (run a flow against stored fixtures and compare outputs). Assertions plus pins cover the immediate need. |

### Security (SEC)

| ID | Pri | Requirement |
|---|---|---|
| SEC-1 | M | **Dev server exposure.** When the Vite dev middleware is mounted, any non-`/api/ext` request from a non-loopback address or non-loopback `Host` gets **403** (same guard as the UI API), and Vite `server.fs.deny` adds `**/data/**`. Spec 06 states "HOST=0.0.0.0 exposes only `/api/ext`"; today the Vite middleware (`index.js:222-223`) is mounted without that guard, so `/@fs/<repo>/data/config.json` (the token) may be served to other hosts in dev mode. |

## Data model additions

```jsonc
// step
"timeoutSec": 900,
"retry": { "max": 0, "backoffSec": 10 },            // command steps; AI transient retries are automatic
"allowDenials": false, "allowEmpty": false,
"input": { "allowNonUpstream": false },            // added to spec 15 input
"assertions": [ { "name": "tiene casos", "type": "json", "path": "cases", "op": "lengthGte", "value": 1, "severity": "error" } ]
// flow
"runTimeoutSec": 3600
// run
{ "id", "flowId", "status", "trigger", "vars": {}, "flowSnapshotHash", "flowUpdatedAt", "deadlineAt",
  "usePins": false, "idempotencyKey": null, "eventSeq": 0,
  "totals": { "costUsd", "inputTokens", "outputTokens", "durationMs" },
  "steps": { "<id>": { "status", "code", "error", "skipReason", "exitCode",
    "inputs": [ { "step", "stepId", "source": "run|pinned|lastRun", "fromRunId", "at", "viaRef" } ],
    "usage": { "model", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "costUsd", "numTurns", "durationMs", "durationApiMs", "judge": {} },
    "attempts": [ { "n", "startedAt", "endedAt", "status", "error", "reason": "first|transient|correction" } ],
    "assertions": [ { "name", "type", "pass", "severity", "message", "durationMs" } ] } } }
```

## API changes

| Method & path | Change |
|---|---|
| `POST /api/ext/flows/:flow/run` | Body adds `usePins?`, `deadlineSec?`; header `Idempotency-Key`. `vars` per run only. `timeoutSec` keeps meaning "how long to wait". Wait elapsed → 202 + `timedOut:true`. |
| `GET /api/ext/flows/:flow/runs/:runId` | Summary adds `vars`, `usedPins`, `totals`, `deadlineAt`, per step `code, inputs, usage, attempts, assertions, skipReason, durationMs`. |
| `POST /api/ext/flows/:flow/runs/:runId/cancel` | New (EXT-12). |
| `GET /api/ext/flows/:flow/runs/:runId/events?after=` | New (EXT-15). |
| `POST /api/flows/:id/runs/:runId/cancel` | New, UI API. |
| CLI | `afs run … --pins --deadline <s> --key <idempotency> --follow`; `afs cancel <flow> <runId>`; exit codes per EXT-14. |
| MCP | `run_flow` adds `usePins, deadlineSec, idempotencyKey`; new `cancel_run`; `isError` + `structuredContent` per EXT-13. |

## UI (minimal)

- **Node badge:** add statuses `queued` (hourglass), `timeout` (clock), `interrupted`; ✓/✗ count of assertions when the step has any.
- **"Datos" tab, Input section:** per upstream row show provenance chip `run` / `📌 fijado` / `última ejecución (r_… , fecha)`; stale ones (`lastRun`, `pinned` in an external run) highlighted. Show the run's effective `vars`. For commands, the rendered command shows `$env:AFS_V0` with the value beside it.
- **"Datos" tab, Output section:** new "Verificación" block: schema result, each assertion (name, pass/fail, message), judge reason.
- **"Actividad" tab header:** one line `duración · turnos · tokens in/out · costo equiv. USD · intentos N` and the `code` of the failure (e.g. `PERMISSION_DENIED`). Events `queued`, `retry` (with reason and wait), `timeout` appear in the log.
- **Config tab:** fields Timeout (s), Reintentos (commands), "Permitir permisos denegados", "Permitir salida vacía", and an "Aserciones" list editor (type, fields, severity). Flow settings: "Tiempo máximo de ejecución (s)".
- **Runs list:** per-run Cancel button; totals (cost, duration).

## Acceptance criteria

All checks run against a local server (default `http://127.0.0.1:4317`; the 2026-11-10 acceptance used an isolated instance `PORT=4319 AFS_DATA=<empty temp dir>` so user flows were untouched). UI API calls use `Content-Type: application/json` from loopback. External calls use `Authorization: Bearer <token>` with the token from `GET /api/info`. Fixture flows are created with `POST /api/flows {name}` followed by `PUT /api/flows/:id {steps, edges, vars}`; step ids are read back with `GET /api/flows/:id`. Unless noted, fixtures use `command` steps (no subscription usage). Fixtures are deleted afterwards.

1. **REL-1 injection (PowerShell).** Flow with one command step `Write-Output {{input}}`. `POST /api/ext/flows/<f>/run {input:"x; New-Item -ItemType File $env:TEMP\\afs_pwned.txt", wait:true}` → status `success`, `steps[0].output` equals the input literally, and `%TEMP%\afs_pwned.txt` does not exist. Same with `vars.v` and `{{vars.v}}`, and with `shell: bash` and `shell: cmd` (payloads `x; touch /tmp/afs_pwned` and `x & echo pwned> %TEMP%\afs_pwned.txt`).
2. **REL-2.** Command `Write-Output {{{vars.v}}}`; external run with `vars:{v:"a"}` → HTTP 422, `code: RAW_TEMPLATE_EXTERNAL`, no run file created. External run without `vars.v` (flow default used) → 200.
3. **REL-3 isolation.** Flow var `v="base"`; command `Start-Sleep 3; Write-Output {{vars.v}}`. Two concurrent async runs with `vars:{v:"A"}` and `vars:{v:"B"}` → outputs `A` and `B` respectively; `GET /api/flows/:id` afterwards shows `vars.v == "base"`.
4. **REL-4 snapshot.** Flow A→B, A = `Start-Sleep 4; Write-Output a`, B = `Write-Output old`. Start run; after 1 s `PUT` B's command to `Write-Output new`. Run output of B is `old`.
5. **REL-5 restart.** Start a run with a step `Start-Sleep 60`; after 2 s the run file exists with the step `running`. Kill the server process and start it again → `GET` the run: status `interrupted`, step `interrupted`, `endedAt` set; `GET /api/flows/:id` step `lastRun.status == "interrupted"`.
6. **REL-6/REL-8 step timeout.** Step `timeoutSec: 10`, command `Start-Process powershell -ArgumentList '-c','Start-Sleep 120' ; Start-Sleep 120`. Run with `wait:true` → within 25 s: step `timeout`, run `timeout`, and no `powershell.exe` started by the step remains (checked by comparing PIDs listed via `Get-CimInstance Win32_Process` before/after).
7. **REL-7 run deadline.** Two sequential steps of `Start-Sleep 20`, external `deadlineSec: 15` → run `timeout`, first step `timeout`, second `skipped` with `skipReason: deadline`.
8. **REL-9 semaphore.** With `AFS_MAX_CLAUDE=1`, start two runs each with one role step (model haiku, task "Responde OK"). The second step's events contain `kind:'queued'` and its first attempt's `startedAt` ≥ the first step's attempt `endedAt` − 50 ms (the slot is released just before `endedAt` is stamped).
9. **REL-10 retries.** Command step with `retry:{max:2, backoffSec:1}` that fails the first two times (counter file in `%TEMP%`) and succeeds the third → step `success`, `attempts.length == 3`. Same step with `retry.max:0` → `error`, 1 attempt.
10. **EXT-10 pins.** Flow A→B, A pinned with `{output:"PINNED"}`, A's command `Write-Output FRESH`. External run → B's upstream is `FRESH`, `usedPins: []`. With `usePins:true` → `PINNED`, `usedPins: ["A"]`, A's `inputs`/status show pinned. UI run (`POST /api/flows/:id/run`) still uses the pin.
11. **EXT-11 idempotency.** Two POSTs with `Idempotency-Key: k1` and the same body → same `runId`, second has `idempotentReplay: true`, only one run file. Same key, different `input` → 409 `IDEMPOTENCY_CONFLICT`. After server restart, the replay still returns the same `runId`.
12. **EXT-12 cancel.** Async run of `Start-Sleep 60`; `POST …/runs/<id>/cancel` → 200, run `stopped` within 5 s, no orphan process. Cancel again → 409. Unknown id → 404. `afs cancel` exits 0.
13. **EXT-13 MCP.** Send JSON-RPC to `node bin/mcp.js` over stdio: `tools/call run_flow` on a flow whose step exits 1 → `result.isError === true`, `structuredContent.status === "error"`. On a JSON-output flow that succeeds → `isError` false, text contains a fenced `json` block, `structuredContent.json` equals the step JSON. `tools/list` includes `cancel_run`.
14. **EXT-14 codes.** `afs run <f>` on success → 0; failing step → 1; `--deadline 5` on a 30 s step → 3; `--timeout 2` (wait) on a 30 s step → 3; missing flow argument → 2. HTTP: no token 401; unknown flow 404; `wait:true, timeoutSec:2` on a 30 s step → 202 with `timedOut:true`. All error bodies have `error` and `code`.
15. **EXT-15 events.** Async run; polling `…/events?after=0` then `?after=<next>` returns strictly increasing `seq` with no duplicates and `done:true` after the run ends.
16. **OBS-1/OBS-2 provenance.** Flow A→B and an unconnected C whose command uses `{{steps.A.output}}`: full run → C fails `code: NON_UPSTREAM_REF`. With `C.input.allowNonUpstream:true` → C succeeds and `inputs[0].source == "lastRun"` with `fromRunId` of an earlier run. B's `inputs[0]` is `{source:"run", fromRunId:<this run>}`.
17. **OBS-3 usage.** Role step (haiku, "Responde OK") → summary `usage.inputTokens > 0`, `outputTokens > 0`, `numTurns ≥ 1`, `durationMs > 0`, `costUsd` is a number; `totals.costUsd` equals the sum of steps. Command step → `exitCode: 0`, `durationMs > 0`. A step skipped after a failure has `skipReason: upstream_failed`.
18. **VER-1 strict.** Role step (haiku) with `allowedTools: "Grep Bash(git status:*)"` and task "Ejecuta con la herramienta Bash exactamente este comando: node -e \"console.log(6*7)\"" → step `error`, `code: PERMISSION_DENIED`. (Access `none` + Read cannot produce a denial: Claude Code auto-allows Read inside cwd and safe Bash such as `echo`.) Same with `allowDenials:true` → not failed for that reason. Command steps with empty stdout and exit 0 → `success`.
19. **VER-2/VER-3 schema.** Command emits `{"n":"x"}` with schema `{"type":"object","properties":{"n":{"type":"integer"}},"additionalProperties":false}` → `error` mentioning `$.n`. Schema using `pattern`/`format: "email"` is enforced (previously ignored). Schema text `{"type":"objekt"}` → external run 422 `INVALID_SCHEMA`; UI run step `error` with `code: INVALID_SCHEMA`.
20. **VER-4 correction.** Role step (haiku) with schema requiring `ok: boolean` and a task asking to first answer without JSON, then comply when asked: the step's final `json.ok` exists, `output` comes from the correction turn, `attempts` contains a `correction` entry. (Verified once manually; stochastic.)
21. **VER-5 assertions.** Command `Write-Output '{"cases":[]}'`, format json, assertion `json cases lengthGte 1` → step `error`, `code: ASSERTION_FAILED`, `assertions[0].pass == false`, downstream `skipped`. Same with `severity:"warn"` → step `success`, assertion recorded as failed. `regex`, `contains`, `notContains` and `command` (`exit 1`) assertions each produce a failing and a passing case.
22. **VER-6 judge.** Command output "hola" with judge rubric "La respuesta debe estar en inglés" → `pass:false` with a non-empty `reason`; output "hello" → `pass:true`. `usage.judge.inputTokens > 0`.
23. **SEC-1.** Server started with `HOST=0.0.0.0` in dev mode. From a non-loopback interface address (e.g. `curl http://<LAN-IP>:4317/@fs/<repo>/data/config.json` and `/`) → 403. `GET /api/ext/ping` with token from the LAN IP → 200. From `127.0.0.1` the UI still loads.
24. **Regression.** Spec 06 and spec 15 acceptance criteria still pass, except EXT-4 persistence of vars, which is intentionally changed by REL-3.

## Implementation notes (2026-11-10)

Deliberate differences from the original text (accepted, see DECISIONS D13–D19):
- Env vars are `AFS_V<n>` from 0 (spec said `AFS_T<n>`).
- Access presets now restrict built-in tools via `--tools` (role/skill steps); before, `--allowedTools` only pre-approved and nothing was restricted.
- Tool-list parsing keeps patterns with spaces (`Bash(git status:*)`).
- Correction turn only for JSON/schema failures; empty output and assertions fail directly. Assertions run after `onSuccess`.
- A step timeout ends the run as `timeout`.
- `server.keepAliveTimeout` = 65 s, `headersTimeout` = 66 s (Node's 5 s default caused ECONNRESET for clients pausing between calls).
- `inputs[].at` is `null` for references and pins (only `fromRunId` is filled).

Not implemented this round: persisted `queued` status and its node badge; rate-limit `resetsAt` in retries; `{error, code}` for malformed JSON bodies.

Acceptance evidence (isolated server, 4 Haiku calls): criteria 1–7, 9–19, 21 re-run by the product owner; 8, 17 (AI part), 18 (denial case), 22 (fail case) re-run with Haiku; 18 `allowDenials` case and 22 pass case accepted from the implementer's run; 20 accepted by code reading (`engine.js` correction branch); 23 partially verified; 24 verified for spec 15 criteria 1–4 (criterion 5 needs Haiku, not re-run) and spec 06 via criteria 13–14.

## Open questions
- None blocking. Decisions taken for this round are recorded in `docs/DECISIONS.md` (2026-11-10).
