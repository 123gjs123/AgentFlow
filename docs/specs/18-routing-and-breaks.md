# 18 · Arrows on any side, routing, reusable boxes and breaks

Status: Implemented (2026-11-12). Verified by `test/e2e/10-routing-and-breaks.test.mjs` (API/engine),
`11-ui-routing-breaks.test.mjs` (browser) and two cases in `06-cli-mcp.test.mjs`.

## Request (user, 2026-11-12)

The user asked for four things:
1. Arrows that attach to different places of a box.
2. A box that receives N arrows and sends N arrows. The same output is distributed as the inner agent or role decides, or as the consumer chooses.
3. Reusable boxes.
4. Breaks in the flow to validate outputs.

## Decisions

| # | Decision | Why |
|---|---|---|
| R1 | Every box has an input and an output handle on each side. The handle ids are `in-top|right|bottom|left` and `out-…`. Edges store `sourceHandle`/`targetHandle`. Connections are strict (output → input). Dragging an arrow end moves it (reconnect). | Arrows go where the layout needs them. Old edges without handles still render left→right because `in-left`/`out-right` are rendered first. |
| R2 | An edge has `label`, `pick` (JSON path) and `when` (`route`, `contains`, `notContains`, `regex`, or `json` with the assertion operators). The server keeps only these fields and drops invalid sides or types. | The same output is distributed per arrow without new step types. Conditions reuse the assertion evaluator, so there is one syntax. |
| R3 | `when: route` means the source step decides. Its system prompt gets a "Destinos" section listing the targets. It answers with `<route to="X"/>` (full output) or `<route to="X">payload</route>` (only that payload for X). The tags are removed from the output that flows on. Command steps can print the tags too, and `onSuccess` can return `routes`. | This is "según lo que el agente o rol interno defina". Each destination can receive different content. |
| R4 | An inactive arrow carries nothing. A step whose incoming arrows are all inactive is skipped with `skipReason: not_routed`. That is not a failure: the run stays `success`, and its own arrows stay inactive (cascade). A step with at least one active input runs on the active inputs only. A failed upstream still skips its dependants (`upstream_failed`). | Branches without "error" noise. |
| R5 | A single-step run ignores conditions but applies `pick`. | Testing one box should not depend on routing decisions of the last run. |
| R6 | Reuse = **Duplicate** (copy in the same flow) + **library** (`data/library.json`, "📚 Guardar" → "Mis steps" in ＋ Step). The library stores the configuration only: no id, memory, lastRun, pin or chat. | Copies are predictable. Linked instances (edit one, change all) are deferred: they need versioning across flows. |
| R7 | `step.breakpoint`: `before`, `after` or `both`. UI runs honour it. External runs ignore it unless `breakpoints:true` (API body, `afs --breaks`, MCP `breakpoints`). | CI and Jira callers must never hang waiting for a human by surprise. |
| R8 | At a break the run has `status: paused` and `pauses[]`, which hold the output/JSON/routes to validate, or the inputs it will receive. The step is shown as `paused` ("⏸ en revisión"). WebSocket emits `run.paused` and `run.resumed`. The run deadline clock stops while anything is paused (`pausedMs`). | Reviewing takes human time. That time must not end in `DEADLINE`. |
| R9 | Decisions go to `POST …/runs/:runId/resume` (UI and `/api/ext`) with `{action, step?, output?, json?, feedback?}`. | One endpoint for all callers. |
| R10 | Actions after a step: `continue`, `edit` (downstream receives the edited output/JSON; `reviewed.action = edit`), `retry` (the step runs again with a "Corrección pedida por el revisor" section containing the feedback and the previous output, then pauses again; `reviewRounds`), `stop`. | Validation must be able to fix, not only approve. |
| R11 | Actions before a step: `continue`, `skip` (`skipReason: review`, not a failure; downstream runs) or `stop`. | Avoids spending a call when the input is already wrong. |
| R12 | Errors: `NOT_PAUSED`, `STEP_REQUIRED` (several branches paused), `BAD_ACTION`, `RUN_NOT_FOUND`, `STEP_NOT_FOUND` (ext). Cancelling a paused run stops it. A step paused after it ran ends `stopped`. A server crash while paused gives `interrupted`. | Same failure model as spec 16. |
| R13 | `wait:true` calls return when the run pauses (200, `status: paused`). `afs` exits with code 4. MCP `run_flow` returns `isError:false` and a text that says what to validate, and `resume_run` continues and waits. | The caller always learns that a decision is needed. |
| R14 | The context box applies the same edge rules (shared `edgePayload`). Arrows that would be inactive with the sample data give `EDGE_INACTIVE`, and a missing `pick` field gives `EDGE_PICK_MISSING`. | Spec 17 CTX-1 (preview = what is sent) still holds. |

## Data

- Edge: `{id, source, target, sourceHandle?, targetHandle?, label?, pick?, when?}`.
- Step: `breakpoint?: '' | 'before' | 'after' | 'both'`. In `lastRun`: `routes`, `skipReason`, `reviewed`.
- Run: `breakpoints`, `pauses[]`, `pausedMs`. In each step: `routes`, `reviewed`, `reviewRounds`.

## Deferred

- Linked (shared) boxes across flows.
- Breaks on an arrow (instead of on a box).
- Breaks in the generated CI clients (they treat `paused` as "not success").
