# 25 · Chats are conversations: nothing changes without the user's confirmation

Status: Implemented (2026-11-13). Verified by `test/e2e/19-conversational-chats.test.mjs` (and the updated `08-*`, `18-*`).

## Request (user, 2026-11-13)

> "Que todos los chats sean con ida y vuelta de conversación, es decir que no solo sea input del usuario y acción directa. Que se pueda discutir hasta aplicar los cambios o hacer evaluaciones directas con agente o skill o rol; todo debe tener su conversación, y si se requieren modificaciones sobre el entregable o sobre el agente, rol, skill o contexto, se puedan hacer en modo conversación hasta llegar a la confirmación del usuario."

## What acted without confirmation before

| Where | Direct action |
|---|---|
| General chat | "run_step"/"run_flow" started a run immediately |
| Step chat, "modo mejora" | the agent edited the skill/agent files itself (Edit/Write + acceptEdits) |
| Every chat | `<remember>` saved to memory immediately |
| Step chat of an edit/dev step | the chat inherited Edit/Write/Bash and could change files |
| Flow chat | answered only: it could not propose changes to the flow or its context |
| Deliverable | only editable by hand in the break |

## Decisions

| # | Decision |
|---|---|
| C1 | Shared conversation rules in every chat's system prompt: never change anything; ask when something is unclear; offer alternatives with a recommendation; a refinement is a NEW complete proposal; evaluations are answered directly. |
| C2 | Proposal kinds: `step` (`<step-update>`, now also `addContext`), `flow` (`<flow-update>`: description, vars, addContext, `steps` by name or id), `file` (`<file-update path>` with full content), `output` (`<output-update>`, breaks only), `memory` (`<remember>`), `run` (`<run-request>`). Each is stored on the chat message and applied with `POST …/chat/:key/apply`, or discarded with `…/discard`. Applying twice gives 409. |
| C3 | File proposals are limited to the step's skill folder (any file inside it, new ones too) or the agent's own file. The target is re-checked at apply time. The proposal shows the current content, and the previous content is kept on the proposal after applying. Role or command steps cannot propose files. |
| C4 | Chats get read tools only (`readOnlyTools`: no Bash, Edit, Write, NotebookEdit, nor Atlassian or MCP write tools) plus `--disallowedTools Edit Write MultiEdit NotebookEdit`, whatever the step's access. That access is for runs. The skill/agent folder is added with `--add-dir` so the chat can read it. "Modo mejora" is removed; `improve` is accepted by the API and ignored. |
| C5 | The step chat talks AS the step: with its role, as its agent (`--agent`), or applying its skill (it reads `SKILL.md`). The flow context now includes context sources and command text. |
| C6 | General chat: a run decision becomes a `run` proposal ("¿Ejecuto…?"). Confirming it starts the run (`trigger: chat`, breaks on) after the requirements and quarantine gate. Routed answers carry the target's proposals, which can be applied from the general chat (flow proposals too). |
| C7 | Deliverable in a break: "Usar esta salida" stores the corrected output and JSON on the pause (`edited`), and the run stays paused. Approving continues with it (`reviewed.action = edit`). |
| C8 | External `ask` (API, `afs ask`, MCP `ask_flow`) is a **trigger**, not a person at the keyboard. It follows the defined process without waiting: a run decision starts the run directly, and facts to remember are saved directly (as before spec 25). Changes to the flow definition are never applied from outside: they are returned as `pendingProposals` and stay in the app's chat for a person to review. |
| C9 | **A running flow follows its process; nobody stops it to talk** (user, 2026-11-13: "si se está ejecutando el flujo o si viene un trigger externo no puedes frenarlo, debes seguir el proceso definido; solo la interacción directa con el step en modo detenido o en modo break puede interactuar con el humano"). While a run of the flow is active, a human can chat with a step and apply its proposals only if **that step is paused in a break**; the paused run is attached automatically. Every other chat (other steps, flow, general) and every apply answer **409 `FLOW_RUNNING`**, and the UI disables the input with the reason. From a break a chat cannot launch another run. The chat's cancel button (`POST …/chat/:key/cancel`) only cancels the chat's answer, never a run (it used to call `/stop`, which stopped every run of the flow). |
