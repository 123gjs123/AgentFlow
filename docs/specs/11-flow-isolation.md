# 11 — Flow isolation

**Status:** Implemented (2026-11-20): ISO-1..10, with architect review, adversarial passes and a real simulation (see Implementation).

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

## Implementation

The plan came from an architect review. It was implemented in three parts, then went through adversarial passes and a real simulation.

**ISO-1 / ISO-2** were already true: memory, chats, the router catalog, run history, `{{steps.X}}` and `ctx.runStep` are all per flow. Idempotency keys already carry the flow id.

**ISO-3: each flow has its own folder.**
- **Where.** `store.flowCwd(flow)` decides where Claude and the commands work:
  - the custom directory, if the flow has one;
  - otherwise the flow's own folder `~/.agent-flow-studio/workspaces/<flowId>/` (`AFS_WORKSPACES` overrides it), created the first time it is used. It is deliberately outside the app's data folder;
  - otherwise the user's folder.
- **Older flows.** Flows created before isolation keep working in the user's folder: `config.isolationSince` versus `flow.createdAt`, so no flow file is rewritten. Each such flow has a "Usar una carpeta propia para este flujo" checkbox (Flujo › Directorio de trabajo), which saves `flow.workspace: own|home`.
- **What follows a change of folder.** When the effective folder changes, the flow's conversations start over, because Claude keeps its sessions per folder.
- **Export, preview, delete.**
  - Exports never carry the choice, so an imported flow gets its own folder.
  - Previews and comparisons create nothing (`flowCwdPath`).
  - Deleting a flow removes its folder if it is empty, or moves it to `workspaces/_borrados` if it holds work.
- **Warnings.** "Trabajaría en tu carpeta de usuario" (R-CWD) now fires only when the flow really works there.

**ISO-4/5/10: a token per flow.**
- **Storage.** `server/tokens.js` creates tokens like `afsf_` plus 32 random bytes. `data/tokens.json` keeps an HMAC with this machine's key (spec 26) to validate them, and an AES-GCM box with the same key so the UI can reveal them. Nothing is stored in clear. A data folder copied to another machine validates nothing, and revealing there asks you to regenerate (`TOKEN_KEY_CHANGED`). Tokens can be rotated and revoked, and deleting the flow deletes its token. They never go into an export.
- **Authentication.** The middleware resolves `{admin}` (the global token, which becomes the admin token) or `{flowId}`.
  - A central `ext.param('flow')` check returns 403 `FLOW_FORBIDDEN` on every `/flows/:flow/*` route of another flow, and also for a flow that doesn't exist, so names can't be enumerated.
  - `/flows` lists only the token's own flow, and `/ping` reports the scope.
- **Admin token.** It can be disabled from Ayuda (401 `ADMIN_DISABLED`). On this machine the UI key still opens the API as admin, only from loopback, so the local CLI and MCP keep working.
- **Snippets and integrations (spec 12).** INVOKE.md and the snippets still read `AFS_TOKEN`. Jenkins uses one credential per flow (`afs-token-<flujo>`).
  - "Mostrar token del flujo" in 🔌 Invocar creates the token if needed and can regenerate it.
  - The wizard's "Probar" uses the flow token.
  - The lint also catches a pasted `afsf_…` token.
- **CLI.** It reads `AFS_TOKEN`, then `AFS_TOKEN_FILE`, then the local admin token. `afs token <flujo> [--rotate]` shows or regenerates a flow's token.

**ISO-6/7/8/9: explicit calls between flows.**
- **The 🔀 Flujo step and the hook call.** The step kind 🔀 Flujo takes:
  - `flowRef` (an id);
  - an optional `flowStep` with `only|from`;
  - `flowInput` as a template; empty means the upstream output;
  - `flowVars`;
  - `waitResult`.

  Hooks get `ctx.invokeFlow(nameOrId, input, {step, scope, vars, wait})`.
- **What crosses.** Only the input. The called flow runs with its own vars, memory and folder. The caller gets `result` and `json`.
- **The child run.** It has trigger `flow:<caller>`, `parent` and `callChain`. It goes through the same checks as an external run: quarantine, raw templates, preflight and schemas.
- **Failures and cancellation.**
  - A failed child gives `CHILD_FAILED`; a child that runs past the time gives `CHILD_TIMEOUT` and is stopped.
  - Cancelling the caller stops the child.
  - Fire-and-forget returns the run id, and that run is detached.
  - The child of a rehearsal is a rehearsal too.
- **Recursion guard.** Revisiting a flow fails with `FLOW_RECURSION`, and a chain longer than 5 with `FLOW_CHAIN_TOO_DEEP`, before anything starts. The chain also reaches commands (`AFS_CALL_CHAIN`). The external API honours `X-AFS-Call-Chain`, and the CLI sends it, so `afs run` or `curl` from inside a flow can't bypass the guard.
- **What a 🔀 step doesn't do.** It has no chat, from the UI or through `/ask`.
- **Import.** An import of a flow with a 🔀 step is quarantined and names the local flow it would call. It is relinked only to a flow with that exact name, and says so.
- **Review rules.**
  - R-FLOW-REF, R-FLOW-STEP and R-FLOW-CYCLE (a static cycle) block.
  - R-FLOW-QUARANTINED blocks.
  - R-FLOW-DEPTH is a risk.
  - R-FLOW-HOOK is a risk (also for a computed target).
- **Calls between flows.** `GET /api/flows/:id/calls` lists what a flow calls and what calls it, including literal hook calls. The Flujo tab shows them as links.

**Hardening: processes don't inherit the app's secrets.** Commands and Claude no longer get `AFS_DATA`, `AFS_TOKEN`, `AFS_TOKEN_FILE`, `AFS_UI_KEY` or `AFS_CRED_KEY_FILE`. The recommended hardened setup is to disable the admin token and give each caller its flow's token.

**Tests.** `33-flow-isolation` has 17 tests, all offline:
- the workspace and older flows;
- the token boundary on every route;
- rotate, revoke, machine-bound tokens and no clear text on disk;
- snippets run as pasted, the CLI with its scope, and lint;
- calls, recursion, depth 5 and 6, cancellation, hooks, quarantine, import and `/calls`;
- the adversarial pass regressions;
- the UI.

**Real simulation with the real Claude CLI.** On an isolated server, flow A was invoked from outside with its own token. Claude wrote a sentence, A called flow B through a 🔀 step, Claude translated it in B, and A received the result.
- B's run is linked to A (`flow:A`, chain A→B).
- Each flow worked in its own folder, and Claude kept separate sessions for each.
- A's token got 403 on B and listed only A.

**First adversarial pass.** No high findings. The medium and low ones, all fixed with tests:
- **(M) The admin token reached flows.** A flow's commands inherited `AFS_DATA`, so they could read the admin token and, with it, bypass the recursion guard by calling the external API. Now: `childEnv()` hides the app's secrets, and the call chain travels as `AFS_CALL_CHAIN` / `X-AFS-Call-Chain`.
- **(M) A silent relink on import.** An import relinked a 🔀 step to a sensitive local flow without saying so. It now names that flow in the quarantine and in the warnings.
- **(L) `/ask` on a 🔀 step.** It is now refused.
- **(L) A malformed `tokens.json`.** It is now `TOKENS_CORRUPT`, never a 500 for everyone.
- **(L) The child of a rehearsal.** It is now flagged as a rehearsal in the review and in the run list.
- **(L) Local tools with the admin token disabled.** This was first solved by letting the UI key work from loopback; that was reverted in pass 2, see below.
- **(L) A computed hook target.** It is now reported.
- **(L) Deleting a flow.** A flow that doesn't exist gives 404, and a workspace that couldn't be moved is logged.

**Second adversarial pass.** It found one high, one medium and one low issue.
- **(H) Any command could become admin.** The flow folder was `<DATA>/workspaces/<id>`, so `../../config.json` reached the UI key. With pass 1's change, that key worked on the external API as admin, even with the admin token disabled. Fixed:
  - The flows' folders now live outside the app's data folder (`~/.agent-flow-studio/workspaces`).
  - The UI key is no longer accepted on `/api/ext`; pass 1's change is reverted. With the admin token disabled, the CLI and MCP ask for the flow's token: `afs token <flujo>`, which uses the UI API locally.
  - Launched processes no longer inherit `PORT`, `HOST`, `INIT_CWD`, `OLDPWD` or `npm_*` either, so nothing the app hands a step points at its installation.
  - A test plays the attack: the command doesn't find the configuration, doesn't learn the port or the data folder, and gets 401.
- **(M) The UI key through a tunnel.** It was accepted on `/api/ext` through a tunnel. Gone with the fix above.
- **(L) The recursion guard for external calls depends on the caller.** It relies on the caller forwarding `X-AFS-Call-Chain`; `afs` and the CLI do. Accepted as best effort: within the app (🔀 steps and `ctx.invokeFlow`) the guard is enforced by the server. A command that deliberately calls the API without the header is the person's own code.

**What isolation is and is not.** Commands and Claude run as your Windows user. A flow's folder separates sessions and side effects, and tokens separate who can call what from outside. It is not a sandbox: code you run in a step can read any file your user can. The hardened setup is: admin token disabled, one token per flow for each caller, and steps with only the permissions they need.

**Closing check (closed).** The three fixes from pass 2 held:
- the command environment no longer carries the app's secrets or its location;
- Claude works in the flow's folder, and nothing it receives points at the installation;
- `/api/ext` rejects the UI key in a header, a cookie or the URL;
- the UI API rejects forwarded requests.

Two cheap items it found are fixed:
- Every process the app launches now uses `childEnv`: git on the flow's repos (🔔, review), the Claude probe in the flow's folder, preflight and installs.
- More forwarding headers (`Via`, `X-Forwarded-*`, `X-Client-IP`…) mark a request as proxied, so the loopback-only UI API refuses it.

**Accepted limits (by design).**
- **The installation can be found.** A command or Claude's Bash runs as your Windows user, so it can find where the app is installed, for example from its parent process, and read your files. Only an operating-system sandbox would prevent that. Spec 11 isolates flows from each other in what the app hands them (folder, sessions, memory, tokens), not code you run from the code you run.
- **Hooks run inside the server.** They are JavaScript you write or import, and they can reach the app's data. That is why an imported flow with hooks stays in quarantine until you review it.

Spec 11 is closed. It went through an architect review, two adversarial passes and a closing check, and has a real simulation with the real Claude CLI. `33-flow-isolation` has 18 tests.
