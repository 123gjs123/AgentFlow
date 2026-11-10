# 09 — Flow workspaces, export and import

**Status:** Proposed

## Summary

Each flow lives in **its own self-contained local folder**. The folder holds everything that belongs to the flow: definition, configuration, chats, runs, memory, source-check state and a generated invocation guide. A flow can then be copied, versioned, backed up, **exported** to a single file and **imported** on another machine. Several flows can be loaded side by side, including flows kept inside a project repository.

## Goals
- One folder = one flow, readable by a human.
- Export and import in one click (UI) or one command (CLI).
- Load flows from any folder, e.g. `my-repo/.agent-flows/release-check/`, so they can be versioned next to the code they serve.
- Safe import: nothing an imported flow contains runs before the user has reviewed it.

## Non-goals
- Syncing between machines (use git or a shared drive on the folder).
- Merging two versions of the same flow.

## Requirements

| ID | Requirement |
|---|---|
| WS-1 | Every flow is stored in its own folder (layout below). No flow data lives outside it. |
| WS-2 | On startup, the existing layout (`data/flows/*.json`, `data/chats/<id>`, `data/runs/<id>`) is migrated automatically to the folder layout. The original is kept as a backup. |
| WS-3 | **Export flow** (UI button, `afs export`, `GET /api/flows/:id/export`) produces `<flow-name>.afsflow.json`. Options: include chats, include runs (default: chats yes, runs no). |
| WS-4 | **Import flow** (UI file picker or drag & drop, `afs import <file|folder>`) accepts an `.afsflow.json` bundle or a flow folder. |
| WS-5 | Import never overwrites an existing flow. If the id exists, a new id is assigned and the name gets a suffix (`… (imported)`). |
| WS-6 | Import clears machine-bound state: Claude session ids, the per-flow token (spec 11), schedule `enabled` (set to false) and running status. |
| WS-7 | Import is **quarantined** when the flow contains hooks or command steps. It opens with a banner listing them, and runs, schedules and external invocation stay disabled until the user clicks "I reviewed this, enable". |
| WS-8 | **Link folder:** the user can register an external folder as a flow location. It is used in place, not copied, and stored in `data/config.json → linkedFlows[]`. Unlink removes the registration, not the files. |
| WS-9 | **Open folder** button reveals the flow folder in Explorer or Finder. |
| WS-10 | The flow selector lists all flows (local and linked) with their origin. |
| WS-11 | The folder is kept human-friendly: pretty-printed JSON, a generated `README.md` (purpose, steps, how to run) and `INVOKE.md` (spec 12). |
| WS-12 | Secrets are never written to exports: the global token is never written, and per-flow tokens are dropped from exports. |

## Folder layout

```
<flows-root>/<slug>--<flowId>/          e.g. data/flows/release-check--f_3bcc8959/
  flow.json          definition: name, description, vars, schedule, steps (config + memory), edges, flow memory
  state.json         machine-bound state: step lastRun, chat session ids, context hashes, per-flow token
  sources.json       source-check snapshots and last results (spec 10)
  chats/<key>.json   _global, _flow, <stepId>
  runs/<runId>.json
  workspace/         default working directory for Claude and commands (spec 11)
  README.md          generated summary
  INVOKE.md          generated invocation guide for the flow and each step (spec 12)
```

`flow.json` (portable) is kept separate from `state.json` (machine-bound), so that versioning a flow in git produces clean diffs and doesn't leak sessions.

## Export bundle format

```jsonc
{
  "format": "agent-flow-studio/flow",
  "version": 1,
  "exportedAt": "2026-11-10T18:00:00Z",
  "app": "0.3.0",
  "flow": { /* flow.json */ },
  "sources": { /* sources.json, optional */ },
  "chats": { "<key>": [ /* messages */ ] },   // optional
  "runs": [ /* run records */ ]               // optional
}
```

A zip of the folder can be added later. The JSON bundle needs no extra dependencies and is easy to diff and attach to tickets.

## API

| Method & path | Purpose |
|---|---|
| `GET /api/flows/:id/export?chats=1&runs=0` | Download bundle |
| `POST /api/flows/import` `{bundle}` or `{path}` | Import from bundle or folder path |
| `POST /api/flows/link` `{path}` / `DELETE /api/flows/link/:id` | Link or unlink an external folder |
| `POST /api/flows/:id/reveal` | Open the folder in the OS file manager |
| `POST /api/flows/:id/trust` | Lift the import quarantine |

## Acceptance criteria
- After an upgrade, existing flows, chats and runs appear unchanged, now inside per-flow folders.
- Exporting a flow and importing it on another machine reproduces its steps, edges, vars, memory and (if included) chats. Sessions are not carried over, and chats continue in a fresh session with full context.
- Importing a bundle whose flow contains a command step shows the quarantine banner, and Run stays disabled until the user trusts it.
- A folder linked from a git repo can be edited in the UI, and `git diff` shows only `flow.json` changes for config edits.
