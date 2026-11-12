# Decisions

## 2026-11-10 — Hardening round 1 (spec 16)

Context: adversarial review of runs, external invocation and handoffs. Decisions taken by the product owner without escalation (no scope/cost/credential impact beyond the agreed round).

| # | Decision | Consequence |
|---|---|---|
| D1 | Command templates pass values via env vars (`$env:AFS_Tn`, `"$AFS_Tn"`, `!AFS_Tn!` with `cmd /v:on`) instead of quoting. | No per-shell escaping bugs; authors needing raw splicing use `{{{ }}}`, which external runs may not feed. |
| D2 | External `vars` are per run and never persisted. | Breaking change vs. spec 06 EXT-4; callers relying on persistence must edit flow vars in the UI. |
| D3 | Defaults: step timeout 900 s, run deadline 3600 s (max 14400), `AFS_MAX_CLAUDE` 3, AI transient retries 2 (30 s, 120 s), command retries 0. | Bounded runs; 3 concurrent CLI processes keeps the subscription rate limit reachable but not saturated. |
| D4 | External runs ignore pins unless `usePins:true`; UI runs keep using pins. | CI cannot go green on frozen data; summary reports `usedPins`. |
| D5 | Non-upstream `{{steps.X}}` refs fail full runs unless `input.allowNonUpstream`. | Possible breakage of existing flows that relied on last-output refs; explicit opt-in restores it. |
| D6 | AI steps fail on any permission denial and on empty output (opt-outs per step). Command steps: exit code only. | Fewer false greens; flows that tolerate denials must opt in. |
| D7 | Ajv (pure JS, no native modules) replaces the minimal validator; invalid schema = error / 422. | New dependency `ajv` + `ajv-formats`. |
| D8 | Assertions run after `onSuccess` (verify the final handoff); paths use spec 15 `a.b.0.c` syntax, not JSONPath. Judge defaults to Haiku. | No new path library; judge consumes subscription usage only when configured. |
| D9 | `timeoutSec` on ext run keeps meaning "wait time"; run deadline is the new `deadlineSec`. Wait elapsed → HTTP 202 + `timedOut`. CLI exit 3 = timeout. | Backward compatible for existing callers. |
| D10 | Idempotency keys kept 24 h in `data/idempotency.json`. | Survives restart; replay returns the original run. |
| D11 | SSE deferred; polling events endpoint instead. Per-flow contract tests deferred. | CI/CLI get live progress now; MCP cannot stream in one tool call anyway. |
| D12 | Interrupted runs are marked `interrupted`, not resumed. | Simple, honest state; caller re-runs. |

## 2026-11-10 — Spec 16 acceptance (implementation deviations)

Context: acceptance of spec 16 on an isolated instance (`PORT=4319`, empty `AFS_DATA`). Deviations found in the implementation; accepted by the product owner unless noted.

| # | Decision | Consequence |
|---|---|---|
| D13 | Shell-safe env vars are named `AFS_V<n>` (from 0), not `AFS_T<n>`. | Spec 16 REL-1 and UI text updated; no functional difference. |
| D14 | Access presets restrict built-ins: role/skill steps pass `--tools <built-ins from access list>` (skill adds `Skill`); agent steps keep their agent definition. Reason: `--allowedTools` only pre-approves, it never restricted anything. | Security fix. Flows whose steps silently used tools outside their access list may now get `PERMISSION_DENIED`; users must widen access or set `allowDenials`. Criterion 18 rewritten (Read/echo are auto-allowed, so the old test could not produce a denial). |
| D15 | Tool-list parsing keeps patterns with spaces (`Bash(git status:*)`). | Fine-grained Bash patterns work as written. |
| D16 | Correction turn only for JSON/schema failures; empty output and assertion failures fail without a correction turn. | Predictable cost; one extra turn at most, only where the model can fix format. |
| D17 | A step timeout ends the run with status `timeout` (CLI exit 3), not `error`. | CI can distinguish hangs from failures. |
| D18 | `server.keepAliveTimeout` 65 s / `headersTimeout` 66 s. | No ECONNRESET for CI scripts pausing between calls. |
| D19 | Deferred to round 2: persisted step status `queued` (event only now), rate-limit `resetsAt` in AI retries, `{error, code}` for malformed JSON bodies (today: Express HTML 400 page with stack trace). | Spec 16 status "Implemented with exceptions". The malformed-body page leaks local paths to token holders; fix first in round 2. |
| D20 | External pins and stale refs: provenance `source` values are `run`, `pinned`, `lastRun`; non-upstream `{{steps.X}}` refs fail full runs (`NON_UPSTREAM_REF`) unless `input.allowNonUpstream`. Specs 06 and 15 amended. | Already decided in D4/D5; recorded here as amendments to specs 06/15. |

## 2026-11-11 — Step context box and integration helper (spec 17)

Context: the user asked to see each step's context (role, skill/agent, tools, memory, upstream…) and for help, including AI generation, to configure external callers (Jira Automation, Jenkins). Decided by the product owner. Per-caller tokens are escalated (spec 17 open question 1).

| # | Decision | Consequence |
|---|---|---|
| D21 | The context view is a **preview** (what would be sent now), produced by the same pure builder the engine uses (`buildStepInvocation`), not a parallel approximation. | Engine refactor needed. Fidelity is testable byte-for-byte against `inputView` (CTX-5). |
| D22 | Placement: a collapsible "Contexto" box above the tab content on Config and Chat. Not a new tab (it would hide while editing) and not hover-only (hover stays a Could). | Always visible where config is edited. Collapsed by default to one chip line, so the form keeps its space. |
| D23 | The preview never calls the model: no Haiku summaries (shown as `pending`), and MCP status comes from the cached init or an explicit probe. Tokens are estimated as chars/4 and labelled "≈". What Claude Code adds by itself (base prompt, CLAUDE.md, MCP schemas) is listed but not counted. | Zero subscription cost for previews. The estimate is honest about what it does not measure. |
| D24 | "Datos" stays the immutable record of what was sent. The box shows the current preview, with a diff against the last run. | Two clear concepts: past (Datos) and now (box). |
| D25 | Integration helper = deterministic templates for 12 callers, plus optional AI adaptation (Sonnet, no tools) grounded on the template, and a mandatory lint gate (token literal, endpoint, flow/step names) with one correction turn. | Works with no AI cost for common cases. AI output cannot ship the token or a wrong endpoint. |
| D26 | Generated code never contains the token. It uses the caller's secret store. `?token=` only for callers that cannot set headers, with a warning. | Tokens stay out of repos and Jira rule exports. |
| D27 | The app never starts a tunnel and never suggests `HOST=0.0.0.0` for cloud callers. Preferred order: run the job on this machine (runner/agent + `afs`), then a Cloudflare Tunnel restricted to `^/api/ext/`, then Funnel/ngrok, then invert to polling. | Minimum exposure by default. Jira Cloud needs a tunnel or polling. |
| D28 | Requests with proxy-forwarding headers are treated as remote (UI API, UI, WS → 403). | Closes the "tunnel rewrites Host to localhost" hole that would expose the tokenless UI API. Security hardening, no policy change. |
| D29 | `dryRun` on the ext run endpoint (and `afs --dry-run`) validates without starting a run or consuming the idempotency key. Plus an in-memory inbound log (last 50, no bodies or tokens). | "Probar" costs nothing. Users can see whether Jira/Jenkins actually reached the server. |
| D30 | Results back to Jira Cloud: the flow comments through the Atlassian MCP, and the call is fire-and-forget (Jira's web request waits only ~30 s). CI callers wait or poll, map exit codes and archive `afs-result.json`. | No fragile long waits in Jira. CI stages fail correctly. |
| D31 | Default idempotency keys come from the caller's natural id (`BUILD_TAG`, `issue.key`+`issue.updated`, `run_id`+`run_attempt`…). | Retries by the caller don't start duplicate runs (spec 16 EXT-11). |
| D32 | `config.publicUrl` is set by the user, never auto-detected. | Snippets for cloud callers use the real public base. No guessing. |

## 2026-11-11 — Spec 17 acceptance (implementation deviations)

Context: acceptance of spec 17 on an isolated instance (`PORT=4319`, empty `AFS_DATA`, 1 Haiku + 1 Sonnet call). The product owner accepts these deviations. Template and wizard defects T1–T11 stay open in the spec.

| # | Decision | Consequence |
|---|---|---|
| D33 | CTX-1 is met by shared pure pieces (`systemSections`/`userSections`, `cliOptions`, `buildArgs`) instead of one `buildStepInvocation`. | Criterion 3 proves byte-identical system/user/tools. Any new prompt part must be added as a section in `prompt.js`, or the preview drifts. |
| D34 | CI and script callers share two stdlib clients (`afs_call.py`, `afs-call.ps1`) that hold the HTTP contract. Pipeline files only pass arguments. Templates live in one file, `server/integrations.js`. `bash-cron` uses the Python client, not curl. | One place to fix contract bugs (T6, T7). Callers need python3 (Linux) or PowerShell (Windows) on the agent. Criterion 14 is read as "the generated output", not "the Jenkinsfile". |
| D35 | Generated `source` must equal the caller id (INT-3). The current first-segment/ad-hoc values (`jira`, `tarea`, `bash`…) are a defect (T9), not a decision. | The wizard's "first call arrived" indicator must match on the caller id. |
| D36 | Deferred: CTX-6 `summary: cached`, CTX-16 hover, the "Datos" ↔ box links, the exact-request "Probar", the INT-13 p90 gate. | Spec 17 status "Implemented with exceptions". |
| D37 | Generated YAML/Groovy must survive any flow name the app accepts (`:`, `#`, `'`). `scripts/verify/int-templates.mjs` keeps a hostile-name fixture (`Smoke: QA #1 'x'`); it must pass before T1–T5 are closed. | Today 11 hostile-name checks fail (T1, T2, T5; T4 Groovy found by reading). |
| D38 | Release gate = functional e2e suite in `test/e2e/` (`npm run test:release`: build + all suites, JUnit in `test-results/`). It runs real servers with a mock Claude CLI (`test/e2e/mocks/claude-mock.mjs`) and executes the code generated for every caller against the server. Two test seams in production code: a `CLAUDE_BIN` ending in `.js/.mjs/.cjs` runs with the same Node, and `AFS_TIME_SCALE` scales retry waits and schedule intervals (default 1). | No subscription use, no change to real flows. Defects found while writing it and fixed in the same change: (1) the transient-error regex held backspace characters, so "API Error: 5xx" was never retried; (2) `shell: cmd` steps received `\"` around quoted values (Node's argv escaping): cmd now gets the line verbatim (`/s /c "…"`); (3) a hook that does not compile was ignored and the step succeeded: now `HOOK_ERROR`; (4) the FOREIGN_HOST lint exempted any host containing "example"; now only `example.com/org/net` and placeholders; (5) the Jira body sent `source: "jira"` (D35), so the wizard's "llamada recibida" never lit up; the wizard also accepts `mcp` for the MCP caller; (6) the context box said an upstream that is pinned but has never run would get "(sin salida)" in an external run, which executes it. |
| D39 | Spec 18: edges carry `label`/`pick`/`when` (conditions reuse the assertion evaluator; `route` lets the source step choose destinations and per-destination content with `<route to>`); all-inactive inputs → `not_routed` (not a failure). Reuse = duplicate + library copies (no linked instances). Breaks: `step.breakpoint` before/after/both, honoured by UI runs and by external runs only with `breakpoints:true`; the deadline stops while paused; `POST …/resume` with continue/edit/retry/skip/stop. | No new step types, one condition syntax, callers never hang by surprise. Details and deferred items in docs/specs/18. |
| D40 | Code review fixes (3 independent reviewers, 2026-11-12). Security: the UI (pages, `/api`, `/ws`) requires a per-installation UI key (link `/?k=…` printed at start, `start.cmd`, `afs ui` → HttpOnly SameSite=Strict cookie) because loopback + Host + no forwarding headers can be faked by TCP forwarders; PowerShell literals double typographic quotes and become ASCII-only expressions for non-ASCII text (PS 5.1 reads BOM-less scripts as ANSI); the Jira body JSON-escapes literal text; config/idempotency files are never silently reset on read errors. Engine: bash `"…{{x}}…"` emits a bare reference (no word splitting/globbing) and quotes are detected by a quote-state scanner; steps no longer hang when a child keeps a pipe open (`exit` + grace); UTF-8 decoded with StringDecoder; PIDs are tracked with start time and removed on exit, recovery only kills processes from this boot; worker exceptions abort siblings; deadline only paused while nothing executes; JSON correction keeps the system prompt and the chosen routes; pinned steps keep routes; summaries cached per arrow; hook `runStep` uses the run snapshot; break retries keep their cost. UI: no lost edits (versioned save, flush before switching flows/chats/tests), safer markdown (no images/forms/styles, links open outside), rename rewrites `{{steps.X}}` references, review modal keeps drafts, error boundary. CLI: HTTP/connection errors exit 2, argument validation, auto-start on the `AFS_URL` port. | Deferred: multi-tab concurrent editing of the same flow (needs revisions on PUT). |
