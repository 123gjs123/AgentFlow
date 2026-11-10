# 11 — Flow isolation

**Status:** Proposed. Some of it is already true; see the table.

## Summary

Many flows can be loaded at the same time, but each one is a **sealed unit**. A flow cannot see another flow's steps, chats, memory, runs, variables or files, and cannot be reached by another flow's callers. The only way across the boundary is an **explicit invocation**: a sub-flow step, a hook call or the external API with that flow's credentials.

## Goals
- No accidental context leakage between flows (e.g. a client-specific flow and a personal one).
- Least-privilege external access: a CI job for flow A cannot trigger flow B.
- Explicit, visible cross-flow calls.

## Requirements

| ID | Requirement | Today |
|---|---|---|
| ISO-1 | Chats, memory, related memory, router catalog and run history are scoped to one flow. | ✅ already true |
| ISO-2 | `{{steps.X.output}}` and `ctx.runStep` resolve only within the same flow. | ✅ already true |
| ISO-3 | Each flow has its own default working directory, `<flow folder>/workspace/`. Claude's per-project state (sessions, auto-memory) and command side effects therefore don't mix across flows or with the user's home. A custom `cwd` is still allowed. | ❌ shared home dir |
| ISO-4 | **Per-flow tokens:** each flow has its own external token, which grants access to **that flow only**. The global token remains as an "admin" token, can be disabled, and is shown separately in the UI. | ❌ global only |
| ISO-5 | `GET /api/ext/flows` with a per-flow token lists only that flow. | ❌ |
| ISO-6 | Cross-flow calls are explicit only: (a) a new step kind **Flow** (`flowRef`, optional `flowStep`, `waitResult`), (b) `ctx.invokeFlow(nameOrId, input, {step, vars})` in hooks. | ❌ |
| ISO-7 | A cross-flow call passes **only the input**. The called flow runs with its own vars, memory and cwd. The caller receives the result (the run summary's `result`) and nothing else. | ❌ |
| ISO-8 | Cross-flow call graphs are checked for recursion at run time: an invocation chain longer than 5, or one that revisits a flow, fails. | ❌ |
| ISO-9 | The UI shows which flows a flow calls and which call it, as links in the flow settings. | ❌ |
| ISO-10 | Per-flow tokens are machine-bound (`state.json`), never exported (spec 09) and can be rotated individually. | ❌ |

## Design notes
- **Flow step kind:** it behaves like a step in the parent run. Its activity shows "→ invoking flow X (run r_…)" and links to that run. The child run is recorded with trigger `flow:<parentFlowId>`.
- **Authorization middleware:** it resolves the token to a scope `{admin} | {flowId}`. Every `/api/ext/flows/:flow/*` route checks that the resolved flow matches the scope.
- **Workspace:** created lazily. Commands and Claude use `flow.cwd || <folder>/workspace`. The help text explains that Claude's file tools are still limited by permissions, not by cwd.

## Acceptance criteria
- Two flows each have a step chat about "SBK-123". Memory stored in flow A never appears in flow B's `<related-memory>`.
- A request to flow B with flow A's token gets 403. The admin token works for both.
- A Flow step in A that calls B returns B's result as its output. B's chats and memory are unchanged except for B's own run.
- A calls B, and B calls A: the run fails with a recursion error.
