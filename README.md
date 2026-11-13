# Agent Flow Studio

A local visual builder and runner for **AI agent flows** on top of **your own Claude Code CLI**.

Build a flow by placing boxes on a canvas and connecting them with arrows. Each box is a role, a Claude Code agent, a skill or a shell command. You can:

- run the flow from the UI, a terminal, CI (Jenkins, GitHub, GitLab, Bitbucket), Jira Automation, a webhook or another agent (MCP);
- watch what happens inside every step;
- verify each output before it moves on.

Runs use your Claude Code login: your subscription, skills, agents and MCP connectors (Atlassian, Drive…). No API key is needed.

> The UI text is in Spanish. This README and the specs are in English.

---

## Contents

1. [Features](#features)
2. [Requirements](#requirements)
3. [Install and start](#install-and-start)
4. [Quick start: your first flow](#quick-start-your-first-flow)
5. [Concepts](#concepts)
   - [Steps (boxes)](#steps-boxes)
   - [Arrows: N inputs / N outputs, routing](#arrows-n-inputs--n-outputs-routing)
   - [Data between steps and templates](#data-between-steps-and-templates)
   - [Output verification](#output-verification)
   - [Breaks: validate before continuing](#breaks-validate-before-continuing)
   - [Reliability](#reliability)
   - [Memory, chats and hooks](#memory-chats-and-hooks)
   - [Context box](#context-box)
   - [📎 Context: consultation sources](#-context-consultation-sources)
   - [Reusable boxes](#reusable-boxes)
   - [Pinned outputs](#pinned-outputs)
   - [Undo, redo and versions](#undo-redo-and-versions)
   - [Several tabs](#several-tabs)
   - [Simple and complex flows](#simple-and-complex-flows)
   - [Requirements: what a flow needs on the machine](#requirements-what-a-flow-needs-on-the-machine)
   - [Sharing flows: export and import](#sharing-flows-export-and-import)
   - [Schedules](#schedules)
6. [Running flows from outside](#running-flows-from-outside)
   - [External HTTP API](#external-http-api)
   - [`afs` CLI](#afs-cli)
   - [MCP server (other agents / Claude Code)](#mcp-server-other-agents--claude-code)
   - [Integration assistant (Jira, Jenkins, GitHub…)](#integration-assistant-jira-jenkins-github)
7. [Security model](#security-model)
8. [Configuration (environment variables)](#configuration-environment-variables)
9. [Data on disk](#data-on-disk)
10. [Architecture and technologies](#architecture-and-technologies)
11. [Project structure](#project-structure)
12. [Tests](#tests)
13. [Troubleshooting](#troubleshooting)
14. [Specifications](#specifications)

---

## Features

**Canvas and flows**
- Boxes connected by arrows on any side.
- One box can feed many and receive from many, which forms a DAG that runs in parallel by levels.
- Flows can be created empty, from a demo, or **from a plain-language description** (Claude designs the flow using your skills and agents).

**Step kinds**
- Role (your own instructions).
- Claude Code agent (`--agent`).
- Skill.
- Shell command (PowerShell, bash, cmd).

**Data passing**
- Full output, JSON only, summary (Haiku), or explicit references such as `{{steps.Analyze.json.cases}}`.
- Per arrow you choose which **JSON field** travels and **when** the arrow is active.
- The source agent can also decide which destinations receive its output, and send different content to each one.

**Verification**
- JSON output with JSON Schema and one automatic correction turn.
- Assertions: `contains`, `regex`, JSON operators, a shell command, or an AI judge.
- Strict success: denied permissions or an empty output fail the step.

**Breaks**
- Pause before or after a box.
- Approve, edit the output, re-run the step with feedback, skip it or stop the run.

**Visibility**
- Live activity for every step: tool calls, results, hooks, retries.
- Provenance of every input and per-step token and cost usage.
- A **context box** that shows exactly what the model will receive.

**Reliability**
- Shell-safe templates.
- Step timeouts and run deadlines.
- Automatic retries on transient errors (never after a write).
- Global limit of concurrent Claude processes.
- Durable runs that survive restarts (marked `interrupted`).
- Cancellation and idempotency keys.

**External invocation**
- Token-protected HTTP API, the `afs` CLI and an MCP server.
- An **integration assistant** that generates ready-to-paste code for 12 callers, with lint and reachability checks.

**Conversations**
- A chat per step, with a persistent session and proposals you apply with a button.
- A general chat with a router that decides which step answers or what to run.
- Memory per step and per flow.

---

## Requirements

| | |
|---|---|
| Node.js | 20 or newer; **22.15 or newer** behind a corporate TLS-intercepting proxy, so the server can trust the Windows/macOS certificate store (tested with 24) |
| Claude Code CLI | installed and logged in (`claude` on `PATH`, or set `CLAUDE_BIN`) |
| OS | Windows 10/11 (primary target), Linux, macOS |
| Optional | Git Bash (bash steps on Windows), Python 3 (generated CI clients), Chromium via `playwright-core` (browser tests) |

---

## Install and start

```bash
git clone https://github.com/123gjs123/AgentFlow.git
cd AgentFlow
npm install
npm start            # prints  http://127.0.0.1:4317/?k=<ui-key>   (Windows: double-click start.cmd, it opens it)
```

Open the printed link once: it carries the **UI access key** and the browser keeps it in a cookie, so afterwards the plain address works. Lost it? Run `node bin/afs.js ui` (opens it) or `node bin/afs.js ui --print`.

If `npm install` fails behind a TLS-intercepting proxy, run `NODE_OPTIONS=--use-system-ca npm install`.

Other commands:

```bash
npm run dev          # server with auto-restart on changes in server/
npm run build        # build the UI into dist/
npm run prod         # build + serve the built UI (NODE_ENV=production)
```

Without `NODE_ENV=production` the server mounts Vite in middleware mode and serves the UI from source with hot reload.

---

## Quick start: your first flow

1. Open the link printed by `npm start` (or run `start.cmd` / `afs ui`) and pick one of the three options:
   - **✨ Con IA**: describe the flow, for example "read a Jira ticket, design test cases with my qa skill, review them and comment the result on the ticket";
   - **Demo**;
   - **+ Flujo** (empty).
2. Add boxes with **＋ Step**: templates, your skills and agents, or **📚 Mis steps**. Connect them by dragging from an output dot (filled) to an input dot (hollow).
3. Click a box and fill in **Config**:
   - kind;
   - what it does (task);
   - how it works (role);
   - access (tools);
   - output format;
   - assertions;
   - break.
4. **▶ Ejecutar flujo**, write the input (a ticket key, a requirement, JSON…) and watch the boxes turn green. The **Actividad** and **Datos** tabs show what each step did, received and produced.
5. Call it from outside: **Flujo → Invocar** generates the code for your caller.

---

## Concepts

### Steps (boxes)

| Kind | What runs | Notes |
|---|---|---|
| 🎭 Role | `claude -p` with your role and task appended to the system prompt | Model, effort, permission mode and tools per step. |
| 🤖 Agent | `claude -p --agent <name>` | Agents come from `~/.claude/agents`, plugins or the project's `.claude/agents`. The agent file defines its tools. |
| 🧩 Skill | `claude -p` with the `Skill` tool and an instruction to use that skill | Skills come from `~/.claude/skills`, claude.ai, plugins or the project's `.claude/skills`. |
| ⌨️ Command | PowerShell, bash (Git Bash on Windows) or cmd | stdin = upstream outputs. Env vars: `FLOW_INPUT`, `STEP_UPSTREAM`, `STEP_UPSTREAM_JSON`, `AFS_RUN_ID`, `AFS_STEP`. |

**Access (least privilege).** Each AI step lists its tools, for example `Read Grep Bash(git status:*) mcp__claude_ai_Atlassian_Rovo`:

- Built-in tools outside the list are **not available** (`--tools`).
- The listed ones are pre-approved (`--allowedTools`).
- Anything that would need a permission prompt is denied in headless mode, and the step fails with `PERMISSION_DENIED`. You can opt out with "Permitir permisos denegados".
- Presets: read, Atlassian read, Atlassian read/write, edit files, dev (edit + Bash), none.

**Execution order.** Execution follows topological levels of the graph; independent boxes run in parallel (`AFS_MAX_PARALLEL`, default 2). Cycles are rejected. Each run works on a **snapshot** of the flow, so editing the flow while it runs does not change that run.

### Arrows: N inputs / N outputs, routing

- Every box has an input and an output dot on **each side**. To move an arrow, select it and drag one of its highlighted ends to another dot, or simply draw it again between the same boxes from the dots you want.
- A box can receive from N boxes and send to N boxes.
- Click an arrow to configure it:

| Setting | Effect |
|---|---|
| **Label** | Shown on the arrow. The destination receives it as the section title (`### Source → label`). |
| **What passes** (`pick`) | Empty = the full output (text + JSON). A JSON path such as `cases` or `risks.high` sends **only that part**, so one output can be split among destinations. |
| **When** (`when`) | `always`; a JSON field condition (`=`, `≠`, `≥`, `≤`, exists, matches, length); contains / not contains a text; a regex; or **🧭 the source step decides**. |

**When the source step decides:**
- Its system prompt lists the possible destinations.
- It picks them with `<route to="Name"/>` (the destination gets the full output) or `<route to="Name">content</route>` (that destination gets only the content).
- The tags are removed from the output that flows on.
- Command steps can print the same tags.

**Inactive arrows:**
- An inactive arrow carries nothing.
- If **all** inputs of a box are inactive, the box is **not routed**: it does not run, it is not an error, and boxes that depend only on it are not routed either. Conditional arrows are drawn dashed.
- If an upstream box **fails**, its dependants are skipped (`upstream_failed`) and the run fails.

### Data between steps and templates

An AI step receives the following in its user prompt:
- the task (rendered);
- the outputs of the boxes before it, according to its **input mode**;
- the flow input;
- the run variables.

| Input mode | What upstream outputs look like |
|---|---|
| `full` | Text + JSON block |
| `json` | Only the JSON |
| `summary` | Long outputs are summarized by Haiku first |
| `refs` | Nothing automatic; the task pulls exactly what it needs with references |

**Templates**, usable in tasks, context and commands:

| Template | Value |
|---|---|
| `{{input}}` | Flow input |
| `{{vars.issue}}` | Flow variable (external calls can override it **for that run only**) |
| `{{steps.Name.output}}` | Text output of an earlier step |
| `{{steps.Name.json.a.b}}` or `{{steps.Name.a.b}}` | A JSON field |
| `{{steps.Name.files}}`, `{{steps.Name.actions}}` | Files written / external actions performed |
| `{{upstream}}` | All upstream outputs (commands) |

- A reference may only point to an **earlier** step in the graph (`NON_UPSTREAM_REF`), unless you enable it on the step.
- In command steps every value is passed through an **environment variable**, never pasted into the command line. Injection is not possible in PowerShell, bash or cmd.
- `{{{raw}}}` (triple braces) pastes the value verbatim. It is rejected with 422 when the value comes from an external caller.

Each step records the **provenance** of its inputs: this run, a pinned output, or the last successful run.

### Output verification

- **JSON output.** Set *Output → JSON* and optionally a JSON Schema (Ajv; draft-07 and 2020-12). The step must end with a `json` block. If the block is missing or invalid, the engine asks for **one correction** in the same session (`--resume`). Codes: `INVALID_JSON`, `SCHEMA_MISMATCH`, `INVALID_SCHEMA`.
- **Assertions** run on the final output, each one with severity `error` (fails the step) or `warn`:
  - `contains`, `notContains`, `regex`;
  - `json` with `exists`, `equals`, `notEquals`, `gte`, `lte`, `lengthGte`, `lengthLte`, `matches`;
  - `command`: a shell command gets the output on stdin and `AFS_OUTPUT_JSON`, and exit 0 = pass;
  - `judge`: an AI judge (Haiku by default, no tools) with a rubric and an optional minimum score. The output is wrapped in nonce-delimited markers, so instructions inside it are treated as data.
- **Strict success.** Denied tools → `PERMISSION_DENIED`. An empty output (no text, JSON, files or actions) → `EMPTY_OUTPUT`. Both can be opted out per step.

### Breaks: validate before continuing

Set **Config → Break** on a box: *before*, *after* or *both*. When a UI run reaches it:

- The run pauses (`status: paused`). The box shows "⏸ en revisión" and the **Revisar** window opens.
- **After**: you see the output and JSON, and choose:
  - **Approve and continue**;
  - **Edit output**: downstream boxes receive your version;
  - **Re-run with a correction**: the step runs again with your feedback and its previous output, then pauses again;
  - **Stop**.
- **Before**: you see what the box will receive, and choose **Run and continue**, **Skip** or **Stop**.
- The run deadline **does not count** paused time.
- **💬 Improve with chat** (both kinds of break): talk to the step about *this* execution. The chat sees what the step received and, after a run, what it produced, its error and the command it ran. Ask for a change, for example "the filter should only bring my team's apps". The step proposes it (task, role, command, output format or flow variables), you **Apply** it, then:
  - after a run: **Re-run with the changes** runs the step again with the new definition and pauses again;
  - before a run: **Run with the changes** runs it with the new definition.

  Only that button loads the edited step and variables into the running execution. Any other edit made while a run is in progress applies from the next run on.

External runs ignore breaks unless they ask for them:
- with `breakpoints: true` (API), `--breaks` (`afs`) or `breakpoints` (MCP);
- they then get `status: paused` back, with the output to validate;
- they continue with `POST …/runs/:runId/resume` (`continue | edit | retry | skip | stop`), `afs resume` or the `resume_run` MCP tool.

### Reliability

| Mechanism | Detail |
|---|---|
| Step timeout | `timeoutSec` per step (default 900 s); the whole process tree is killed (`TIMEOUT`) |
| Run deadline | `runTimeoutSec` per flow (default 3600 s) or `deadlineSec` per call (`DEADLINE`) |
| Transient retries | API 5xx / overloaded / rate limit / CLI died without a result: up to 2 retries (30 s, 120 s), **never** if the failed attempt already wrote files or called a write tool |
| Command retries | `retry: {max, backoffSec}` with exponential backoff; cancelling during the wait never re-runs |
| Concurrency | At most `AFS_MAX_CLAUDE` (default 3) Claude processes at once; extra ones show as `queued` |
| Durable runs | Saved when a step starts and every 5 s; after a crash or restart, unfinished or paused runs become `interrupted` and orphan processes are killed |
| Cancellation | Per run (UI, API, CLI, MCP) or the whole flow |

### Memory, chats and hooks

- **Memory.** Each step has its own memory and the flow has a general one. During runs, steps add facts with `<remember>fact</remember>`; in chats, saving to memory is a proposal you confirm. You can also add or remove facts by hand. Step memory goes into that step's system prompt.
- **Chats are conversations; nothing changes until you confirm.** Every chat discusses with you, asks when something is unclear, and evaluates what you ask directly. When it wants to change something, it sends a **proposal**:
  - **Aplicar** (or **Ejecutar**, **Guardar**, **Usar esta salida**) applies it;
  - **Descartar** drops it;
  - or keep talking, and it sends a new, complete proposal.

  | Proposal | Who can make it | What it changes |
  |---|---|---|
  | Step change | step chat | role, task, context, tools, model, command, output format, flow variables, added context sources |
  | Flow change | flow chat (or general chat routed to the flow) | description, variables, context sources, several steps by name |
  | File change | chat of a Skill or Agent step | the skill's files (inside its folder) or the agent's file; the full new content is shown next to the current one |
  | Deliverable | step chat inside a break (after) | the output the next steps receive when you approve |
  | Memory | any chat | adds a fact to the step's or the flow's memory |
  | Run | any chat | runs the flow or a step (requirements are checked first) |

  Chats only get **read** tools, even when the step has edit, dev or Atlassian-write access (that access is for runs). Write tools are explicitly blocked.
- **Step chat.** A persistent Claude session for one box, talking **as** that box: with its role, as its agent (`--agent`), or applying its skill (it reads the skill's `SKILL.md`).
  - It receives the box's configuration, last run and memory. The context block is only re-sent when it changes.
  - If the session expired, it starts a new one with the full context.
- **General chat.** A router (Haiku, no tools) decides whether a step or the whole flow answers, and shows why. If you ask it in the app to run something, it proposes the run (step or flow and input) and waits for **Ejecutar**.
- **When a person can talk to a step.** A running flow follows its defined process and nobody stops it to talk.
  - While a run is active, you can only converse with a step that is **paused in a break**. The chat sees that execution and its changes apply to it ("Re-ejecutar con los cambios").
  - Every other chat is disabled until the run ends; the API answers `409 FLOW_RUNNING`.
  - **Cancelar respuesta** in a chat cancels only that answer, never a run.
- **External triggers follow the process.** External `ask` (API, `afs ask`, MCP `ask_flow`) never waits for a person: it runs what it is asked to run and saves facts to memory directly. Changes to the flow definition are not applied from outside: they come back as `pendingProposals` and wait in the app's chat.
- **Chat keys.** Enter sends; Alt+Enter (or Shift+Enter) inserts a new line. The **Enviar** button works too.
- **Hooks.** Per-step JavaScript functions:
  - `onStart(ctx)`: change the input or skip the step;
  - `onSuccess(ctx)`: transform the output or JSON, or return `routes`;
  - `onFailure(ctx)`.

  `ctx` offers `sh`, `ai(prompt, {tools})`, `runStep`, `remember`, `setVar` and `log`. A hook that does not compile fails the step (`HOOK_ERROR`).

### Context box

At the top of each step's **Config** and **Chat** tabs, the box shows **exactly** what will be sent. It is built by the same functions the engine uses:

- every system and user prompt section, with its source and destination (system, user, CLI, Claude Code, not sent) and an estimated token count;
- the CLI flags (`--tools`, `--allowedTools`, model, agent…);
- the skill or agent file;
- the upstream data, including which arrows would pass;
- warnings: missing skill, reference to a non-earlier step, secret-looking variable sent to the model, invalid schema, inactive arrow…

You can preview with UI or external-run semantics, type a test input, or replay the exact data of a past run and compare.

### 📎 Context: consultation sources

Each step has a **📎 Contexto** section in its Config. The flow has **📎 Contexto del flujo**, under Flujo, which every step can use.

What you can attach:
- a document (any file: .md, PDF, Word, code…; you can also upload one);
- a folder;
- a web page;
- Jira: a ticket, several, an initiative or epic with its children, or a JQL query;
- Confluence: a page, optionally with its children.

How it reaches the model:
- Sources are **not pasted into the prompt**. The model gets a short index, "what is available and where", plus the access to reach each source:
  - read access to the folders and files (`--add-dir` + Read/Grep/Glob);
  - WebFetch for pages;
  - the Atlassian MCP read tools for Jira and Confluence.
- Each skill, agent or role consults them when it needs to.
- References accept templates (`{{vars.issue}}`, `{{input}}`).
- Each source shows a ✓/✗ check, and a folder browser helps pick paths.

### Reusable boxes

- **Duplicate** copies a box in the same flow.
- **📚 Guardar** saves its configuration to **Mis steps** (`data/library.json`). From **＋ Step** you insert it, already configured, into any flow.
- Memory, runs, pins and chat sessions are never copied.

### Pinned outputs

Freeze a step's output (from its last run, or typed by hand) to test the steps after it without running it again.

- UI runs use pins.
- External runs **ignore** them unless they pass `usePins: true`.

### Undo, redo and versions

- **Undo / redo**: Ctrl+Z, and Ctrl+Y or Ctrl+Shift+Z (⌘ on macOS), or the ↶ ↷ buttons in the toolbar.
  - Each action is undone on its own: changes that came later from another tab or a hook are kept, and run results are never undone.
  - Inside a text field, Ctrl+Z undoes the typing in that field.
- **Versions** (**Flujo → Versiones**):
  - While you edit, a version is saved automatically at most every N minutes. The default is 5; 0 turns it off. The state before your first change is kept too.
  - **Guardar versión** saves a named one, which is never deleted.
  - **Restaurar** brings a version back. It first saves the current state as "Antes de restaurar…", so you can go back.

### Several tabs

Each browser tab keeps its own flow: it is in the URL (`?flow=<id>`), the tab title shows its name, and **⧉** opens the current flow in a new tab. The same flow can be open in several tabs:

- Every save carries the revision it was based on. If another tab, an applied chat proposal or a hook (`ctx.setVar`) changed the flow meanwhile, the server answers 409 and the tab **merges field by field**: changes to different steps, fields or arrows are combined.
- If both changed the same field, your version wins and a notice says so.
- Other tabs see each save live. Creating, renaming or deleting a flow updates every tab's list.

### Simple and complex flows

Most flows need nothing special: steps that read and reason, with no working directory and no cleanup.

Flows that build things (clone a repo, build a Docker image, run Argo or kubectl from an image, write code) use these opt-in pieces:

- **Working directory** (Flujo tab, with a folder browser). If it is set and does not exist, the run does not start (`CWD_MISSING`). If it is empty, steps that can write or run commands warn that they would work in your home folder.
- **Al terminar (siempre)**. A command that runs after every full run, whatever the result: success, error, cancel, timeout, or a server restart. Use it for cleanup, for example `docker compose -p afs-{{run.short}} down -v`. It receives `AFS_RUN_ID` and `AFS_RUN_STATUS`.
- **Run ids in templates**: `{{run.id}}`, `{{run.short}}`, `{{run.date}}`. Use them for branch names, compose projects and artifact folders.
- **Restricted terminal access**: "Editar + terminal restringida (git sin push, docker)". Only those commands are pre-approved and there is no web access. For other tools, use custom `Bash(kubectl:*)` / `Bash(argo:*)` patterns.
- **Recommended pattern**:
  - command steps for deterministic work: clone, build, measure;
  - AI steps that hand off a JSON contract, read by later steps with `{{steps.X.json.y}}`;
  - command assertions that verify claims;
  - breaks before expensive or risky steps;
  - "Al terminar" for cleanup.

  See [docs/specs/22](docs/specs/22-workspace-finally-access.md).

### Requirements: what a flow needs on the machine

Flujo → **✅ Requisitos para usar este flujo** lists what a person needs before running the flow. Each item has a "how to get it" text.

- **🧰 Tool**: installed, with an optional check such as Docker running.
- **📄 File**: for example a secrets file. With a template, **Crear desde plantilla** creates it with the key names; you fill in the values.
- **🔑 Environment variable**.
- **🌐 Reachable service**: VPN or QA environment.
- **🔌 MCP connector**: for example Atlassian.

**✨ Sugerir** proposes them from what the flow uses.

They are checked before every run. If something required is missing, the run does not start: the UI shows **"Antes de ejecutar este flujo…"** with the instructions, and the API, `afs` and MCP answer `PREFLIGHT_FAILED` with the list. A header chip warns when the open flow is missing something. Recommended items never block.

### Sharing flows: export and import

**⬇ Exportar** downloads `<name>.afsflow.json`. It contains:
- steps, arrows, variables, context, requirements, "Al terminar", assertions and breaks;
- memory, chats, run history and pins only if you choose to include them.

It never contains your sessions, your token or your UI key. Secret-looking variables are exported empty, and the schedule is exported disabled.

**⬆ Importar** (in the toolbar, or on the welcome screen) creates a new flow; it never overwrites one. If the flow contains anything that would execute on your machine (commands, hooks, terminal or file-writing access, "Al terminar"), it opens **under review**:
- a banner lists those things;
- runs and chats stay blocked until you click **"Revisé este flujo, habilitar"**.

Its requirements tell you what to install first.

From a terminal: `afs export <flow> -o file.afsflow.json` and `afs import file.afsflow.json`.

### Schedules

**Flujo → Programación**: run the flow every N minutes with a fixed input. A scheduled run does not start while the previous one is still running.

---

## Running flows from outside

The token is shown in **Ayuda → Invocar desde fuera** and stored in `data/config.json`. It can be rotated.

### External HTTP API

Base: `http://127.0.0.1:4317/api/ext`.

Authentication, in order of preference:
1. `Authorization: Bearer <token>`;
2. `X-AFS-Token: <token>`;
3. `?token=` (last resort: the token ends up in logs).

| Method and path | Purpose |
|---|---|
| `GET /ping` | Health check |
| `GET /flows` | Flows with steps and **variable names** (never values) |
| `POST /flows/{flow}/run` | Start a run. `{flow}` = id or name. Body: `input` (string or JSON), `vars`, `step` (only that step), `wait` + `timeoutSec`, `deadlineSec`, `usePins`, `breakpoints`, `source`, `dryRun`. Any other JSON body (a raw webhook payload) becomes the input. `text/plain` is accepted too. |
| `GET /flows/{flow}/runs/{runId}` | Summary: status, final `result`, `json`, per-step output/status/code/error/usage/assertions/routes, `totals`, `pauses` |
| `GET /flows/{flow}/runs/{runId}/events?after=<seq>` | Incremental activity events (polling with `seq`) |
| `POST /flows/{flow}/runs/{runId}/cancel` | Cancel one run (other runs keep going) |
| `POST /flows/{flow}/runs/{runId}/resume` | Decide at a break: `{action, step?, output?, json?, feedback?}` |
| `POST /flows/{flow}/ask` | Ask the flow (router) or one step: `{message, step?}` |

How a run call behaves:
- **`wait: true`**: the response is the run summary. If `timeoutSec` expires first you get **202** with `timedOut: true`; the run keeps going.
- **`Idempotency-Key` header**:
  - the same key with the same body returns the same run (`idempotentReplay: true`), unless that run failed, in which case it runs again;
  - the same key with a different body → **409** `IDEMPOTENCY_CONFLICT`.
- **`dryRun: true`**: validates the flow, step, variables, schemas and token without running anything.

Errors are JSON `{error, code}`. Codes include `UNAUTHORIZED`, `FLOW_NOT_FOUND`, `STEP_NOT_FOUND`, `RUN_NOT_FOUND`, `RUN_FINISHED`, `BAD_VARS`, `RAW_TEMPLATE_EXTERNAL`, `INVALID_SCHEMA`, `IDEMPOTENCY_CONFLICT`, `NOT_PAUSED` and `BAD_ACTION`.

```bash
curl -X POST "http://127.0.0.1:4317/api/ext/flows/My%20flow/run" \
  -H "Authorization: Bearer $AFS_TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: build-1234" \
  -d '{"input":"PROJ-123","vars":{"issue":"PROJ-123"},"wait":true,"timeoutSec":600}'
```

### `afs` CLI

`node bin/afs.js …`, or `npm link` and then `afs …`.

```text
afs list
afs run <flow> [-i text | -f file | stdin] [--var k=v]… [-s step] [--json] [--follow]
               [--pins] [--deadline s] [--key k] [--breaks] [--dry-run] [--no-wait] [--timeout s]
afs status <flow> <runId>
afs cancel <flow> <runId>
afs resume <flow> <runId> --action continue|edit|retry|skip|stop [--step S] [--output T] [--feedback T]
afs ask <flow> "question" [--step S]
afs ui [--print]          # open the UI with its access key (or just print the link)
afs export <flow> [-o file] [--chats] [--runs] [--no-memory]
afs import <file.afsflow.json>
```

- Exit codes: `0` success, `1` the run failed or was stopped, `2` usage error or the call itself failed (HTTP error, unreachable server, bad token), `3` timeout, `4` paused at a break.
- Environment: `AFS_URL` (default `http://127.0.0.1:4317`) and `AFS_TOKEN` (default: read from `data/config.json`).
- If the local server is not running, `afs` starts it.

### MCP server (other agents / Claude Code)

`bin/mcp.js` is a stdio MCP server exposing the tools `list_flows`, `run_flow`, `get_run`, `cancel_run`, `resume_run` and `ask_flow`. Register it once:

```bash
claude mcp add agent-flows -s user -- node /path/to/AgentFlow/bin/mcp.js
```

Run results come back as text plus `structuredContent`. `isError` is set when the run did not succeed; a run paused at a break is not an error.

### Integration assistant (Jira, Jenkins, GitHub…)

Open **Flujo → Invocar → Asistente de integración** and follow the steps:

1. Pick the caller. There are 12:
   - Jira Cloud and Jira Data Center Automation;
   - Jenkins declarative and scripted;
   - GitHub Actions, Bitbucket Pipelines and GitLab CI;
   - Windows Task Scheduler (PowerShell), bash/cron and a Python script;
   - Claude Code / another agent via MCP;
   - a generic webhook.
2. Describe what should happen and map the flow's variables to the caller's data (`{{issue.key}}`, `${BUILD_NUMBER}`, `${{ github.sha }}`…).
3. Click **Generar** (deterministic template) or **Adaptar con IA** (Claude adapts the template to your description).

How the generated code is built:
- **Caller data never goes through a shell.** It is written as `{ENV_NAME}` placeholders that the shared clients (`afs_call.py`, `afs-call.ps1`) expand themselves.
- **The token** lives in the caller's secret store, never in code.
- **Idempotency key**: the caller's natural key (`BUILD_TAG`, run id + attempt, issue key + updated time…).
- **Lint** blocks:
  - a literal token;
  - calls to other hosts;
  - `| sh`, `Invoke-Expression`, base64 or `set -x`;
  - printed secrets;
  - unknown endpoints, flows or steps;
  - missing auth.
- **Reachability**: the assistant tells you whether the caller can reach your PC:
  - local, LAN (`HOST=0.0.0.0`) or public URL;
  - otherwise the options: run the job on this PC, a Cloudflare tunnel limited to `^/api/ext/` (config generated), Tailscale Funnel/ngrok, or reverse the direction (a scheduled flow that reads Jira).
- **Probar (sin ejecutar)** sends a dry run, and an indicator turns green when the first real call arrives.

---

## Security model

- **UI access key**: every UI page, `/api/*` call and the WebSocket need a per-installation key (`uiKey` in `data/config.json`). It is given once through the `/?k=…` link the server prints, `start.cmd` or `afs ui`, then kept in an HttpOnly, SameSite=Strict cookie. A TCP forwarder or a proxy that adds no forwarding headers would otherwise look local.
- **UI API (`/api/*`)**: loopback only. Requests are rejected when:
  - they carry proxy or tunnel headers (`X-Forwarded-For`, `Forwarded`, `CF-Connecting-IP`, `ngrok-trace-id`…), so a tunnel that rewrites `Host` cannot expose the UI;
  - the `Host` or `Origin` is not local;
  - a `POST` is not `application/json` (CSRF).

  The WebSocket follows the same rules.
- **External API (`/api/ext/*`)**: token required, compared in constant time. It is the only thing reachable through a tunnel.
- **Network exposure**: the server binds `127.0.0.1` unless `HOST` is set. Commands and hooks run on your machine with your permissions, so only expose `/api/ext`.
- **Data handling**:
  - variables are listed by name only;
  - generated code never contains the token;
  - the AI integration adapter redacts the token from your description;
  - malformed bodies return JSON errors without stack traces or paths.
- **Vite dev server**: file access is restricted (`fs.allow` / `fs.deny`).

---

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` exposes `/api/ext` to the LAN; the UI stays local-only) |
| `AFS_DATA` | `./data` | Data directory |
| `CLAUDE_BIN` | auto (`claude` / npm global `claude.exe`) | Claude Code CLI; a `.js/.mjs/.cjs` path runs with the same Node (used by tests) |
| `AFS_MAX_CLAUDE` | `3` | Max concurrent Claude processes (runs, chats, router, judge, summaries) |
| `AFS_MAX_PARALLEL` | `2` | Max parallel steps per run level |
| `AFS_BASH` | Git Bash on Windows, `bash` elsewhere | Shell for `bash` steps |
| `AFS_TIME_SCALE` | `1` | Scales retry waits and schedule intervals (tests use `0.01`) |
| `NODE_ENV` | — | `production` serves `dist/`; otherwise Vite middleware |
| `AFS_URL`, `AFS_TOKEN` | — | Used by `afs` and the MCP server |

---

## Data on disk

Everything is plain JSON under `data/` (git-ignored):

```
data/
  config.json        API token, UI access key, public URL
  flows/<id>.json    flow definition (steps, arrows, vars, memory, schedule, last run per step)
  runs/<flow>/…      one file per run (status, events, outputs, usage, pauses)
  chats/<flow>/…     step and general chats
  idempotency.json   Idempotency-Key → run
  library.json       "Mis steps" (reusable boxes)
```

---

## Architecture and technologies

```
 Browser (React + React Flow)  ──HTTP/WS──►  Node server (Express + ws)  ──spawn──►  claude -p --output-format stream-json
                                                 │                                      (your login, skills, agents, MCPs)
 Jenkins / GitHub / Jira / curl ──/api/ext──►    ├─ engine: DAG runner, arrows/routing, breaks, retries, assertions
 afs CLI / MCP server ──────────/api/ext──►      ├─ prompt + context: prompt building shared with the context preview
                                                 ├─ integrations: templates, lint, reachability, AI adaptation
                                                 └─ store: JSON files in data/
```

**Server**
- Node.js (ESM).
- Express 4 for the HTTP API and `ws` for WebSocket push of run, step and chat events.
- Ajv + ajv-formats for JSON Schema (draft-07 and 2020-12).
- Child processes for Claude Code and the shells (PowerShell, cmd, Git Bash), with process-tree kill (`taskkill /T` on Windows).

**Client**
- React 18 and @xyflow/react 12 (React Flow) for the canvas, with dagre for auto-layout.
- marked + DOMPurify for markdown.
- Vite 6.

**Claude integration**
- The Claude Code CLI in headless mode (`-p`, `--output-format stream-json`), with these flags as needed: `--append-system-prompt-file`, `--resume`, `--agent`, `--tools`, `--allowedTools`, `--permission-mode`, `--model`, `--effort`, `--no-session-persistence` and `--strict-mcp-config`.

**Other pieces**
- Clients: the `afs` CLI and an MCP stdio server (JSON-RPC 2.0), with no extra dependencies.
- Generated integration clients: Python 3 (stdlib only) and PowerShell 5.1+/7.
- Tests: `node:test`, a mock Claude CLI, generated code executed for real, and `playwright-core` (Chromium) for the browser.

---

## Project structure

```
server/
  index.js          HTTP + WebSocket server, UI API, external API, guards
  engine.js         runs: DAG levels, arrows/routing, breaks, retries, timeouts, assertions, chats, schedules
  claude.js         spawns the Claude Code CLI, parses stream-json, concurrency slots
  prompt.js         prompt sections, templates, shell quoting, arrow payloads, routes
  context.js        context preview (same functions as the engine)
  integrations.js   callers, templates, lint, reachability, AI adaptation, inbound log
  schema.js         Ajv validation
  store.js          JSON persistence, library
  catalog.js        skills and agents discovery
client/src/         App, Canvas, Panels (step/flow/arrow), Review (breaks), Context, Data, Chat, Events, Integrations, Help
bin/                afs.js (CLI), mcp.js (MCP server), client.js (shared HTTP client)
scripts/verify/     template verifier + tiny YAML parser
test/e2e/           functional end-to-end suites, mock Claude CLI, harness, caller simulators
docs/specs/         product and technical specs (01–18), docs/DECISIONS.md
```

---

## Tests

The functional end-to-end suite has **193 tests**, including regression tests for every code-review fix.

- It starts real isolated servers (temporary data and HOME, free port) with a **mock Claude CLI**, so it never uses your subscription or touches your flows.
- It **executes the code generated for each external caller** against the server.
- The browser suites drive the real UI in Chromium.

```bash
npm run test:release   # build + all suites, JUnit report in test-results/e2e-junit.xml
npm run test:e2e       # all suites
node --test --test-reporter=spec test/e2e/10-routing-and-breaks.test.mjs   # one suite
```

The browser suites need `playwright-core`: install it in the project (`npm i -D playwright-core && npx playwright install chromium`) or point `AFS_PLAYWRIGHT` to an existing `playwright-core` folder. Without it they are skipped with a notice. On failure they save a screenshot to `test-results/`.

Coverage per suite, the mock directives and how to add a test: [test/e2e/README.md](test/e2e/README.md).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| The page says it needs the "enlace con la clave" | Open the link printed by `npm start`, or run `start.cmd` / `node bin/afs.js ui`. The browser remembers it afterwards. |
| The flow selector does nothing, or "El servidor no responde" | The server is not running: `npm start`. The page reconnects by itself. |
| `PERMISSION_DENIED` | The step tried a tool outside its access list. Add it under *Acceso*, or enable "Permitir permisos denegados". |
| `EMPTY_OUTPUT` | The step returned nothing. Check *Actividad*, or enable "Permitir salida vacía". |
| `NON_UPSTREAM_REF` | A `{{steps.X}}` reference points to a box that is not before this one. Connect them, or enable "allow non-upstream". |
| A box shows "no enrutado" | None of its input arrows passed: check the arrow conditions or the `<route>` choices in the source step's output. |
| A run stays "⏸ en pausa" | It is waiting at a break: click **Revisar** (or `afs resume` / `POST …/resume`). |
| Jira Cloud / GitHub cannot reach the PC | Use a tunnel limited to `/api/ext/`, a self-hosted runner, or a scheduled flow that reads Jira (see the integration assistant). |
| `npm install` TLS errors behind a proxy | `NODE_OPTIONS=--use-system-ca npm install` |

---

## Specifications

Specs live in [docs/specs/](docs/specs/README.md), from architecture (01) to arrows, routing and breaks (18). Decisions are in [docs/DECISIONS.md](docs/DECISIONS.md).
