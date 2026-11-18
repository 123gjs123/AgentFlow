# 30 · 🧭 Coordinador del flujo

Status: **Implemented** (2026-11-18; e2e: `test/e2e/26-coordinator.test.mjs`).

## Summary

A flow can have one **coordinator** step, marked with a checkbox and shown with 🧭 on the canvas. It sits right after the intake (for example after "Pull Jira") and does three things:

- It classifies each request and decides which parts of the flow run.
- Arrows further down can depend on its decision.
- It attends the general chat: it answers, consults the step that knows the answer, or proposes a run.

## Origin

The user's QA flow ran every ticket through every step. In practice:
- Some tickets only need the QA analysis.
- Others only need test cases built or evaluated.
- Others only need automation.

Jira does not follow the plan either. Sprints drop and add work, a ticket analysed a month ago can come back as Ready For Testing, and the person asks for specific things from the chat. Who decides what to do is the coordinator, and that decision belongs right after the intake, not between two analysis steps.

## Goals

1. **Enter the flow anywhere.** The coordinator routes each request to the entry point of the work it needs (`<route to>`, spec 18). A step runs if **any** of its incoming arrows carries data, so a step in the middle of the flow runs even if the steps before it did not.
2. **Arrows that depend on the decision.** An arrow's condition can look at the output of an **earlier step of the same run** (`when.from`), not only at its origin. Example: "Entregable → Preparar repo only if the Coordinador chose automation". What travels along the arrow is still the origin's output.
3. **Chat.** With a coordinator, the general chat goes to it instead of the Haiku router. It can:
   - answer;
   - consult up to 2 steps with `<consult step="X">question</consult>`;
   - propose a run with `<run-request>`.

   A consulted step answers in its own chat, with its own context and memory. The coordinator then answers the person using those answers. Every exchange shows in the general chat, and the consultation tags are never shown. There is no second round of consultations, so no loops.

4. **The general chat is a work table.** You talk with one step, or with several, and the coordinator decides who answers when that is unclear.

   | You write | Who answers | Who is at the table afterwards |
   |---|---|---|
   | `@Step …` | That step, directly, with no router or coordinator in between | That step. Later messages without `@` go to it |
   | `@Other …` while talking with someone | `Other` | Both |
   | A message that names one or more of those at the table | The named ones | Unchanged |
   | A message that names nobody, with several at the table | The one(s) the coordinator chooses. It decides with its role and model in one short call, and says why | Unchanged |
   | `@Coordinador` / `@todos` / `@flujo`, the ✕ on each participant, "volver a 🧭 …", or "nueva conversación" | The coordinator | Nobody: back to the coordinator |

   - Names are matched without accents or case, and the longest name wins. A step's id also works, and an e-mail address is not a mention.
   - The table is `flow.chatParticipants`. It is machine state, not part of the definition. The coordinator never sits at it.
   - `PUT /api/flows/:id/chat/_global/participants` changes the table, and a WebSocket `chat.participants` event updates the UI.
   - The chat input autocompletes after `@` (Tab picks the first match). Above it, the UI shows who is at the table.

## Non-goals

- The coordinator does not run anything from the chat: it proposes, and the person confirms (spec 25).
- No "for each ticket" fan-out (spec 15, proposed). A run processes the tickets the coordinator picked for each phase, and automation handles one ticket per run because the environments are shared.

## Design

| Piece | Where |
|---|---|
| `step.coordinator: true` | Travels with the definition (versions, export). Only one per flow: marking another one unmarks the previous one (server, on save). |
| `when.from` (step id) | `cleanEdge` keeps it, except for `route`. The engine evaluates the condition on that step's output in this run. If that step did not run, the arrow is inactive and the reason is given. The arrow panel offers "Mirar la salida de" with the step's ancestors. The canvas label adds "(en «X»)". |
| General chat | `globalChat`: if the flow has a coordinator, it calls `coordinatorChat` (`relayedTurn` × up to 4: coordinator, consulted steps, coordinator). Its chat system prompt adds `coordinatorChatAddendum` (the steps and the three ways to act). |

## The user's flow (SBK, Offering Platform)

```
Pull Jira → 🧭 Coordinador ─(análisis)──────────→ Alcance → Interpretar → Estrategia → Tests existentes → Selección → Entregable
                          ├─(solo casos)─────────────────────────────────↗                                                    │ si el Coordinador eligió automatizar
                          └─(solo automatización)→ Preparar repo ←─────────────────────────────────────────────────────────────┘
                                                        → dev → qa → ppd y veredicto → Cierre y PR
```

- **Pull Jira** prints the person's request ("Pedido de la persona") so the coordinator knows what was asked.
- **The coordinator** reads Jira (status, reason: Dev Analysis moved or Ready For Testing), the ticket folder (what is already done, and when) and the request. It returns JSON with `analisis` / `casos` / `automatizacion` / `en_espera` and, per ticket, its stage, apps and skills per phase.
- **Command steps** filter `tickets.json` with the coordinator's lists, read from `{{steps.Coordinador.json.<fase>}}`, which travels as an environment variable.
- **AI steps** work on the coordinator's selection and load the skills it chose.

On the first real test (SBK-10110), the coordinator:
- saw that the analysis and the cases were still current;
- saw that the closing note was RED with no PR;
- sent the ticket only to automation;
- listed the missing team skills.

## Open questions

- Whether the coordinator should get read-only git, as the review has (spec 28). In the first test it could not check the branch's new commits.
- A "for each ticket" fan-out, for several tickets in parallel phases.
