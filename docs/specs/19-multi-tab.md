# 19 · Several browser tabs (different flows, or the same flow)

Status: Implemented (2026-11-12). Verified by `test/e2e/12-multi-tab.test.mjs`. That suite covers the API, the merge logic and two real browser tabs.

## Request (user, 2026-11-12)

"arma la solución para que soporte distintos flujos en diferentes pestañas". Before this change:
- every tab shared the "last opened flow", so reloading a tab could switch it to another tab's flow;
- a tab that saved overwrote edits made in another tab on the same flow;
- a tab that saved could also undo a chat proposal or a `ctx.setVar` (review finding UI-12).

## Decisions

| # | Decision | Why |
|---|---|---|
| T1 | The open flow belongs to the **tab**. It is kept in the URL (`?flow=<id>`) and in `sessionStorage`; `localStorage` only seeds new tabs. The window title is `<flow> · Agent Flow Studio`. A ⧉ button opens the flow in a new tab. | Reloading a tab, using the back button or opening a link all keep that tab's flow. Tabs are easy to tell apart. |
| T2 | A flow has a revision `rev`. It goes up on every definition edit: UI save (PUT), reset, an applied chat proposal and `ctx.setVar`. Run state (lastRun, memory, pins, chat sessions) does **not** change it. | Runs update the flow file constantly. Those writes must not cause false conflicts. |
| T3 | `PUT /api/flows/:id` accepts `baseRev`. If it differs from the current `rev`, the server answers **409 `FLOW_CONFLICT`** with the current flow and saves nothing. Without `baseRev` the save is unconditional (scripts, tests). | Optimistic concurrency without locks. |
| T4 | Every save broadcasts `flow.updated`, with `by` = the tab id from the `X-AFS-Tab` header. Creating, renaming or deleting a flow broadcasts `flows.changed`, and deleting also broadcasts `flow.deleted`. | Other tabs update live. Their selectors stay current, and a tab whose flow was deleted moves to another one. |
| T5 | A tab keeps the last server version it saw (`base`). When a newer revision arrives (broadcast or 409), it runs a **3-way merge**, field by field, on the flow fields, on each step (by id) and on each arrow (by id). See the merge rules below. | Two tabs editing different things (different steps, or different fields of the same step) never lose work, and true conflicts are visible. |
| T6 | A tab with no unsaved edits simply adopts the newer version. A tab with unsaved edits merges, then retries its save (up to 4 attempts). | |

**Merge rules (T5):**
- A field changed only on one side takes that side's value.
- If both sides changed it, the **local** value wins and the tab shows a notice.
- Additions and deletions come from both sides. If one side deleted something and the other changed it, the changed version is kept and reported.
- Server-managed fields always come from the server.
- Arrows that together would close a cycle are dropped, keeping the server's.

## Not covered

- Real-time co-editing of the same text field, keystroke by keystroke. The unit of merge is the field.
- Undo of a merge. The notice lists the conflicting fields so you can revisit them.
