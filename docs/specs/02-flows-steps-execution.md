# 02 — Flows, steps and execution

**Status:** Implemented

## Summary

A flow is a directed acyclic graph of steps that the user draws on a canvas. Relations are drawn by hand. Both the execution order and the visual layout are computed automatically. Each step's output becomes context for the steps after it.

## Goals
- Unlimited steps with custom names, and many-to-many relations.
- Four step kinds, chosen per step: **role**, **agent**, **skill**, **command**.
- Automatic ordering: topological execution levels and a layered left-to-right layout.
- Live, visible execution of each step.

## Non-goals
- Loops or conditional branching inside the graph. Use hooks (`onStart → {skip:true}`) or a command step for conditions.
- Distributed execution.

## Requirements

| ID | Requirement |
|---|---|
| FLOW-1 | Users can create, rename, describe and delete flows, and switch between them. |
| FLOW-2 | Users can add any number of steps, each with an editable name. |
| FLOW-3 | Users connect steps by dragging from one node's right handle to another node's left handle. Connections that would create a cycle are rejected with a message. |
| FLOW-4 | Each node shows its execution order number (topological level). |
| FLOW-5 | "Sort" re-lays out the graph left to right (dagre). With "auto" on, the layout updates after every structural change. |
| FLOW-6 | The `Delete` key removes the selected step(s) or edge(s). |
| FLOW-7 | A flow runs as a whole with an optional input, or a single step runs on its own. |
| FLOW-8 | Steps in the same level run in parallel (`AFS_MAX_PARALLEL`, default 2). |
| FLOW-9 | If a step fails, all its downstream steps are marked **skipped**. |
| FLOW-10 | A running flow can be stopped. Its child processes are killed. |
| FLOW-11 | Flow variables (JSON) are available as `{{vars.x}}` in tasks and commands, and as `ctx.vars` in hooks. |
| FLOW-12 | Optional schedule: run every N minutes with a fixed input. A scheduled run is skipped if the flow is still running. |
| FLOW-14 | Deleting a step also deletes its chat history. Deleting steps does **not** clear flow-level data, so when the canvas is empty the app lists what is still attached (description, variables, flow memory, chats, runs, active schedule) and offers **Clear all**. Flow settings → *Cleanup zone* clears each part separately, or **Empty flow** resets everything except name, working directory and invocation address (`POST /api/flows/:id/reset {parts}`). |
| FLOW-13 | Each flow has a working directory (`cwd`) used by Claude and by commands. It defaults to the user's home (spec 11 changes this default). |

## Data model (step)

```jsonc
{
  "id": "s_ab12cd34",
  "name": "Design test cases",
  "kind": "role | agent | skill | command",
  "role": "",            // "How does it work?" – persona / extra instructions
  "task": "",            // "What does it do?" – supports {{input}} {{vars.x}} {{steps.Name.output}}
  "context": "",         // fixed reference data (links, project keys, rules)
  "agentRef": "",        // kind=agent: Claude Code agent name
  "skillRef": "",        // kind=skill: skill name
  "command": "", "shell": "powershell | bash | cmd",   // kind=command
  "model": "", "effort": "", "permissionMode": "", "allowedTools": "Read Grep Glob WebFetch WebSearch Skill",
  "hooks": "",           // JS source (spec 03)
  "position": { "x": 0, "y": 0 },
  "memory": [],          // spec 05
  "lastRun": { "status", "startedAt", "endedAt", "output", "error", "runId", "sessionId" },
  "chatSessionId": null, "chatContextHash": null
}
```

The flow also holds `id, name, description, cwd, vars, schedule, steps, edges[{id,source,target}], memory, globalSessionId, createdAt, updatedAt`.

## Step kinds

| Kind | How it runs |
|---|---|
| **Role** | Claude with the user-written role appended to the system prompt. |
| **Agent** | `claude --agent <agentRef>`. The agent's own definition applies, plus the step's role and task. |
| **Skill** | Claude is told to use skill `<skillRef>` through the Skill tool. |
| **Command** | A shell command (PowerShell, bash or cmd) in the flow `cwd`. See "Command steps" below for its inputs. stdout becomes the output, and a non-zero exit code means failure. |

## Execution algorithm

1. `topoLevels(flow)` → `[[ids level 1], [ids level 2], …]`. It throws if the graph has a cycle.
2. For each level, a worker pool of size `MAX_PARALLEL` takes the steps.
3. Each step is re-read from disk just before it executes, so edits made during the run apply.
4. A step whose upstream step failed is marked `skipped`.
5. Upstream context is `[{name, output}]` for each incoming edge. It is the output from this run, or the step's `lastRun.output` when running a single step.
6. `executeStep`, for AI steps:
   - System prompt (appended): step header, kind, role, context, step memory, flow memory, output rules.
   - User prompt: rendered task, upstream outputs (clipped to 12k chars each), flow input (8k), variables.
   - After the run: `<remember>` tags go to memory and are stripped from the output.
7. Status, output and events are saved in the run record and in `step.lastRun`, and every event is broadcast.

**Command steps** receive the upstream outputs on **stdin**. The first step receives the flow input instead. They also get the env vars `STEP_UPSTREAM` and `FLOW_INPUT` and the template `{{upstream}}`, so commands can be chained.

## Access presets

Instead of listing tools by hand, a step chooses an access level. Advanced settings stay available in a collapsed section.

| Preset | Allowed tools | Permission mode |
|---|---|---|
| Read only (default) | `Read Grep Glob WebFetch WebSearch Skill` | — |
| Read Jira / Confluence | read + Atlassian Rovo read tools (getJiraIssue, JQL, getConfluencePage, CQL, search, fetch) | — |
| Read & write Jira / Confluence | read + `mcp__claude_ai_Atlassian_Rovo` (whole server) | — |
| Edit files | read + `Edit Write` | `acceptEdits` |
| Edit + terminal | read + `Edit Write Bash` | `acceptEdits` |
| No tools | (none) | — |

Any tool outside the list is denied by Claude Code. Denials appear in the run's result event and are highlighted in the UI.

## Templates rendering

| Token | Value |
|---|---|
| `{{input}}` | The flow input |
| `{{upstream}}` | Concatenated outputs of the direct upstream steps |
| `{{vars.key}}` | Flow variable |
| `{{steps.Name.output}}` | Last output of the step named `Name` (or with that id) |

## Acceptance criteria
- A three-step chain A → B → C runs in order. C's prompt contains B's output, and the badges show 1, 2, 3.
- Two steps with no relation between them run concurrently.
- If B fails, C is marked `skipped` and the run status is `error`.
- Connecting C → A in a chain A → B → C is rejected.
- A command step `Get-Content -Raw -` (PowerShell) outputs exactly what the previous step produced.
