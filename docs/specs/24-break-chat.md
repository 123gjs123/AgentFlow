# 24 · Chat inside a break: improve a step from its real input and output

Status: Implemented (2026-11-13). Verified by `test/e2e/18-break-chat.test.mjs`.

## Request (user, 2026-11-13)

> "Implementa un chat para poder mejorar tanto el input como el output de cada step en base a la entrada o la salida. Por ejemplo, hay que modificar ese filtro."

It came from a real break: the "Pull Jira" step returned 0 tickets because its JQL filter was wrong (it treated "Dev Analysis" as a status, but it is a sub-task with that title).

## Decisions

| # | Decision | Why |
|---|---|---|
| B1 | The break card has **"💬 Mejorar con chat"**. It opens the step's own chat (same conversation and session as the step panel), embedded in the review window. | One conversation per step; nothing new to learn. |
| B2 | Every message sent from there carries `runId`. The server adds a **`<run-review>`** block built from that execution: the flow input, what the step receives from other steps (before), or what it produced, its JSON and error (after), plus the last commands it ran. | The model reasons on the actual data, not only on the definition. |
| B3 | Proposals (`<step-update>`) may now also change **`command`/`shell`** (command steps), the **output** format and schema, and **flow variables** (`vars`, merged; names `[\w.-]`, values as text). The review window shows each variable as old → new. | The fix is often in a variable (project, time window) or in the command itself. |
| B4 | A run uses the flow as it was when it started (REL-4). After applying a change in the break, the card offers **"↻ Re-ejecutar con los cambios"** (after) or **"▶ Ejecutar con los cambios"** (before). Only that action (`reload: true` in `resume`) loads the saved definition of **that step** and the **flow variables** into the running execution. Without it, the run keeps its snapshot. | You see the effect immediately, without starting a new run, and edits elsewhere never change a run silently. |
| B5 | The chat inside a break never shows "Detener", because that stops every run of the flow, including the one under review. | |

## API

- `POST /api/flows/:id/chat/:stepId` with `{message, runId}`.
- `POST /api/flows/:id/runs/:runId/resume` with `{action: "retry" | "continue", reload: true}`. A `retry` with `reload` and no `feedback` runs the new definition cleanly, without the previous output.
