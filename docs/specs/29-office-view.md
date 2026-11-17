# 29 · 🏢 Vista "Oficina" (animated office view)

Status: **Proposed** (2026-11-17), not implemented. Parked by the user to first refine what exists ("refinemos que todo lo que tenemos ahora funcione correctamente").

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
