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
