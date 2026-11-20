# 29 · 🏢 Vista "Oficina" (animated office view)

Status: **Implemented** (2026-11-20) as option C (a procedurally drawn office), verified by `test/e2e/37-*` and `38-*`. See "Implementation" below.

## Implementation (2026-11-20)

**Decision: option C, a procedurally drawn office.** Option A needs the user's illustration, which is outside the repo and carries institutional coats of arms. Option B needs sprite sheets that do not exist. Instead, the office is drawn in isometric SVG by code:
- Desks are generated from the steps, so it fits any flow.
- It needs no new dependencies and no image assets.
- The characters go through a renderer interface (`client/src/office/characters.jsx`), so sprites can replace the vector people later without touching the logic.

The plan came from an architect review. The open questions are settled:
1. **A or B:** C, as above.
2. **Asset list:** not needed yet.
3. **Characters:** per flow, stored on the step (`step.persona`).

**Where it is.** `🔲 Cajas | 🏢 Oficina` at the top of the canvas area.
- The choice is kept per tab, as the default for new tabs, and in the URL (`?view=office`).
- The office code is its own chunk (`React.lazy`).
- It never edits the flow: clicking opens the existing panels.

| Click on | Opens |
|---|---|
| A desk, character or computer | The step |
| A floor arrow | The edge panel |
| The Memoria shelf | Flujo › Memoria |
| The Contexto shelf or Archivo | Flujo › settings |
| The turn display, Entrada/Salida, Tomás or Expedientes | Flujo › Ejecuciones on that run |
| The window with the bell 🔔 | The break review |

**Modules** (`client/src/office/`; the pure ones are tested from node):
- `model.js`: the cast.
  - Each step gets a distinct name (never "Tomás", who is the coordinator) and a look, both deterministic from the step id.
  - The step's function suggests the name: Análisis → Lucía, Planificación → Marta, Ejecución → Diego, Revisión → Valeria, Archivo → Bruno.
  - `step.persona` overrides both.
- `layout.js`: the floor plan.
  - Reception: the window, the queue, the turn display and Entrada.
  - One column of desks per execution level, at most 6 desks per column and 6 columns per room. More rooms stack below.
  - Each room has the shelves Contexto, Memoria and Expedientes; Salida and Archivo are at the end.
  - Sized to the flow; at most 60 desks, then "+N más".
- `path.js`: BFS walking on the grid.
- `scene.js`: the reducer. It turns the events the app already emits (`run.started`, `step.status`, `run.event`, `run.paused`/`resumed`, `run.finally`, `run.finished`, `review.started`/`done`) into what each character does, following the table above. It is deterministic, and time comes only from the messages. The coordinator's target is derived in this order: a break, an error (the window), "Al terminar" (Archivo), a desk that has just received work, the hub when several desks run, then the chair.
- `Office.jsx`: the view.
  - **Live feed:** it catches up on runs already going, then follows `/ws`, with no duplicates by `seq`.
  - **Movement:** one `requestAnimationFrame` loop moves walkers through refs. It runs only while the office is mounted, the tab is visible and something moves.
  - **Other runs going** wait in the queue with their ticket.
  - **A rehearsal** is drawn in grey.
  - **Toolbar:** "Movimiento reducido" (it follows the system preference unless set), sound off by default (only the bell, a WebAudio ping) and a 📜 Bitácora.
  - **Screen readers:** an `aria-live` summary.
  - **Keyboard:** desks and furniture are buttons (Enter or Space).

**"▶ Ver la jornada".** It rebuilds a stored run into the same messages (`timelineOfRun`) and plays them at 1×, 4×, 8× or 16×. Waits longer than 1.5 s are shortened. "✕ Volver al vivo" returns to the live view.

**`step.persona = {name?, look?}`**
- **Editor:** "🏢 Personaje en la Oficina" in the step's Config tab: name, skin, hair, hair colour, clothes and accessory, a preview, and "↺ Automático".
- **Server cleaning (`cleanPersona`):** the name has at most 40 characters and no control characters; the look keeps 6 known keys, each an integer from 0 to 15.
- **Portable:** it lives in `flow.json` and travels in exports.
- **It never counts as "what executes":** it is left out of the linked-flow fingerprint (spec 09), the step hash and the run snapshot. Renaming a character changes neither the trust of a linked flow nor what a model sees. Like moving a box, it is still a definition change: it can create an automatic version and mark the last AI review as older than the flow.
- **Copies:** a duplicated step or a saved box gets its own character.

**Test contract (`data-*`).**
- `office`: `data-mode` (live/replay), `data-reduced-motion`, `data-animating`, `data-run`, `data-drill`.
- `office-desk`: `data-step`, `data-activity`, `data-status`, `data-name`.
- `office-walker`: `data-step`, `data-activity`.
- `office-coordinator`: `data-target`, `data-tile`, `data-moving`.
- `office-computer`: `data-state` (idle/running/ok/err).
- `office-window`: `data-bell`. `office-salida`: `data-stamp`. `office-display`: `data-ticket`.

**Tests.**
- `37-office-model` (8): the cast, the floor plan (no overlaps, everything reachable, 60 → 10 rooms, overflow), BFS, the reducer row by row, breaks and overlapping runs, replay against live, a real run rebuilt, and persona on the server, including a linked flow.
- `38-ui-office` (7): the toggle and URL, the live run, a break, clicks, replay, reduced motion and a hidden tab, and the persona editor.
- The Claude mock gains `[[mock:hold N]]`, which keeps a step working after its tool calls.

**First adversarial pass.** It found three medium issues and three low ones, each proved with the harness and a browser. All are fixed with regression tests (`revisión 29` in `37-*` and `38-*`):
- **(M) Reloading during a run repeated steps.** While the snapshot was loading, messages that arrived over `/ws` were applied again on top of it, so a step went back to "recibe la carpeta". Buffered transitions the snapshot already has are now skipped. A repeated status counts once; the engine may send `success` several times after a break.
- **(M) The character's name reached the AI review's prompt.** In a linked flow it was a channel with no quarantine, because persona is outside the fingerprint. Persona is now left out of the review dossier and its evidence, so it never reaches a model.
- **(M) A replay survived a change of flow.** The office is now keyed by flow, so a new flow starts live.
- **(L) The live log used the names from when the view opened.** It now uses the current names.
- **(L) A `step.status` without a step id threw.** It is ignored now.
- **(L) Replay could show a finished step still writing.** This happened when the step's last event had the same millisecond as its end. The final status now goes after the step's own events.
- **Closing check.** The 7 fixes hold. It found three more low issues, all fixed:
  - the persona no longer reaches the step contract or INVOKE.md;
  - a success after a break's "continue" no longer repeats the hand-off;
  - a queued step replays as queued.
- **(L) A failed catch-up left the office blind** to a run already going. Live events of an unknown run now start following it.


**Visual redesign (2026-11-20, after the user's feedback "está muy distante de lo que te pasé en la imagen").** The first drawing (dark floor, plain boxes, stick figures) was redone against the reference illustration, with an independent art-direction review whose 15 points were applied:
- **Room.** Warm and bright: thick rosy-beige walls with a skirting board, a cream tiled floor with a sheen, light pooling from a window with blinds and trees, a diorama cut edge with a contact shadow on the dark app. A compact plan: the reception is a pocket closed by a half-wall with glass (doorway at the back of the room).
- **Furniture.** Wooden desks with a bevel, an inset modesty panel and metal legs; half-frosted cubicle partitions; office chairs; monitors with a title bar and buttons, or the terminal of a command (clipped, with a progress bar while it runs); mugs, pencil cups, books, a thermos or a lamp. Metal shelving with binders that have spine labels, archive boxes and pothos hanging from the line of shelves; grey filing cabinets for Archivo. The coordinator's counter has low framed glass, a monitor, coloured folders, an emblem, a chair, and Tomás sitting behind it when idle.
- **Reception.** The red turn display hangs on the left wall (TURNO / VENT., tickets as A + 3 digits, dim history); a TURNOS kiosk with a slanted screen and a paper ticket; blue waiting chairs where other runs sit seen from behind with their ticket; the Entrada/Salida cabinet with wire trays and the rubber stamp; a tall ficus, a water cooler and a coffee corner.
- **People.** Bigger heads, warm-brown outlines, a shaded side, eyes with catchlights, brows, a nose, cheeks, hair with a fringe and a highlight (short, long, wavy, bun, curly, bald), clothes in layers (shirt, blazer, cardigan, hoodie). They sit behind their desk facing the viewer; their forearms and hands are drawn after the desk top, so they type on the keyboard.
- **Signs.** Every sign is mounted on something: shelf boards and COORDINADOR on their faces, and a two-line nameplate on each desk front (function and name, with a status pip and chips for 🔒 or i/n). Labels live in their own layer, so nothing covers them; speech bubbles are shorter and never overlap each other. Floor arrows run along the aisles with one elbow.
- **Zoom.** 100 % (fit) to 250 %, centred, kept per browser.
- **Persona editor.** It also offers the clothes layer (`look.layer`, accepted by the server).

**Known limits, deferred.**
- Replay does not show pauses, resumes or earlier attempts of a retried break. Those status changes are not stored as events.
- Not yet built:
  - sprite characters;
  - typing and ambient sounds;
  - zoom and pan;
  - arcs for papers;
  - door animations;
  - an inspector walking the desks (it stands at the window);
  - a crowd for for-each items (a badge `i/n` instead);
  - visiting the called flow's office;
  - touch support;
  - GIF export.

## Origin

The user shared an isometric illustration of an office and asked for a more fun view, with graphics instead of boxes:
- The office has a coordinator at a service window, people waiting with turn numbers, desks labelled Análisis, Planificación, Ejecución, Revisión and Archivo, shelves labelled Contexto, Memoria and Expedientes, Entrada/Salida trays, and computers.
- Characters move through the space when a task is active.
- The coordinator walks from desk to desk to whoever has to work.
- Commands are computers and context is paperwork.
- Every character is different and has a name.

The reference image is the user's own (kept outside the repo). It contains institutional coats of arms and flags: replace them with the team's logo if the view is ever shared.

## Proposal

A second way of SEEING the same flow, next to the canvas (`🔲 Cajas | 🏢 Oficina`). Editing stays in the canvas; a click on anything in the office opens its panel (step, command, context, run).

### Mapping

| Office | App |
|---|---|
| Coordinator at the window | The flow engine. It walks to the desk of the step that runs and hands over the folder. |
| People waiting + turn display (A035…) | Queued runs (manual, schedule, API, Jira); each turn is a run id. |
| Desks with a character | AI steps (role, skill, agent): name, face and a sign with the step's function. |
| Computers | Command steps. The screen shows the terminal, green or red on the exit code. |
| Shelves Contexto / Memoria / Expedientes | Attached context, the flow's memory, past runs. Reading a source = walking to the shelf and back with a folder. |
| Trays Entrada / Salida | The flow's input and output. |
| Papers passed between people | Arrows: a step's output travels as a folder to the next one. |
| Archivo | "Al terminar" and saved deliverables. |
| Revisión / raised hand | A break: the character raises a hand, the window bell rings (🔔). |

### Events → animation

Everything comes from events the app already emits (`run.started`, `step.status`, `run.event`, `run.paused`, `run.finished`).

| Event | Animation |
|---|---|
| Run starts | The turn display advances; a person leaves the chair and drops a paper in Entrada. |
| Step starts | The coordinator walks (pathfinding) to that desk and hands over the folder. |
| Read / Grep / Glob | The character goes to the Contexto / Expedientes shelf. |
| Edit / Write | Typing; printed pages come out. |
| Bash or a command step | The character sits at a computer; the screen shows the command. |
| MCP / web tools | On the phone, with a "Jira…" bubble. |
| Queued for a Claude slot | Standing with ⏳. |
| Parallel steps | The coordinator distributes the work and waits in the middle. |
| Break | 🙋 a raised hand; the coordinator waits beside the desk until the person answers. |
| Denied tool | A locked drawer 🔒. |
| Error / timeout | A ⛈ cloud and a red paper; the coordinator takes it to the window (🔔). |
| Run OK | An "APROBADO" stamp in Salida; the coordinator goes back to the chair. |
| 🩺 Review / 🧪 Rehearsal | An inspector with a clipboard walks the desks; in a rehearsal everyone works "in grey" (a drill). |

### Characters

One per step, each different and with a name, assigned automatically from the step's kind and function and editable (`step.persona = {name, look}`). Examples: Tomás as coordinator, Lucía in Análisis, Marta in Planificación, Diego in Ejecución, Valeria in Revisión, Bruno in Archivo. More steps than desks → another row of desks or a second room.

### Build options

**A. Overlay on the image** (days)
- The illustration is the background.
- On top: a glow on the active desk, bubbles, computer screens, flying folders, and a coordinator sprite walking a fixed path between desks.
- The painted characters stay still and "work" through effects.

**B. A living office** (weeks)
- An isometric PixiJS scene in the client with grid pathfinding.
- Desks are generated from the flow's steps, so it fits any flow.
- It needs layered assets in the same style:
  - the empty office;
  - furniture pieces;
  - 6–8 characters with sprite sheets (walk in 4 directions, idle, typing, reading, phone, raised hand).
- The user can generate the assets in parts; placeholder characters are used meanwhile.

Recommended: A first, to see it with real data; B once the sprites exist.

### Extras

- **"Ver la jornada":** replay a past run in fast motion (events are stored).
- "Movimiento reducido" switch.
- Sounds off by default (turn bell, typing).
- An idle office (coffee, plants) when nothing runs.
- It renders only while visible.

## Open questions (for when it is resumed)

1. A or B first.
2. The asset list for B (pieces, sizes, frames per animation).
3. Whether characters are per flow or shared by step type across flows.
