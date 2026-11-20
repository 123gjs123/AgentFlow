# 09 — Flow workspaces, export and import

**Status:** Export & import implemented (2026-11-12): WS-3 to WS-7 and WS-12, verified by `test/e2e/17-export-import.test.mjs`. Folder-per-flow storage, migration, linked folders, reveal and README (WS-1, WS-2, WS-8 to WS-11) implemented 2026-11-20 and verified by `test/e2e/34-*`, `35-*` and `36-*`. See "Implementation of the folder layout" below.

## Implementation of the folder layout (2026-11-20)

The plan came from an architect review. It deviates from the original text below in four places, on purpose:
- **The working folder is not inside the flow's folder.** It stays at `~/.agent-flow-studio/workspaces/<id>`, outside the app's data (spec 11, second adversarial pass: a working folder under the data folder let a command read `config.json`).
- **Memory and secret variable values live in `state.json`, not `flow.json`.** `flow.json` is what you would commit: facts learned from Jira or a token must not end up in a repo.
- **A linked folder holds only `flow.json`** (and `README.md` on request). Its history, chats, sessions and `INVOKE.md` (which names this PC's port and paths) stay in the app.
- **Flow skills (spec 13) and context-file uploads stay where they were**, keyed by flow id. Moving them would mean rewriting stored paths and junctions; deferred.

**Layout (WS-1).** `<DATA>/flows/<slug>--<id>/`:
- `flow.json`: the portable definition, with `format`/`formatVersion`, pretty-printed. It is rewritten only when the definition changes.
- `state.json`: machine state. Flow fields: `rev`, dates, `workspace`, `quarantine`, `trust`, `lastDefHash`, sessions, `chatParticipants`, `memory`, `scheduleEnabled`, `secretVars`. Step fields: `lastRun`, sessions, `pinned`, `memory`.
- `chats/`, `runs/`, `versions/`, `reviews/`, `outputs/`, `sources.json`, `actions.json`, `approvals.json`, `copies.json`, `INVOKE.md`, `README.md`.

What this changes in practice:
- A run touches only `state.json`, so editing is the only thing that changes `flow.json`.
- Machine fields are read **only** from `state.json`. A `flow.json` that brings its own `trust`, `quarantine`, sessions or memory is ignored, so a repo cannot grant itself trust.
- The folder is the flow's address. Its id is what follows the first `--`, because a slug never contains `--`.
- A renamed flow gets its folder renamed at the next start, never while it runs (open files would block it).
- Deliverable paths stored in old runs are rebased onto the current folder (`OUT.localPath`), so downloads keep working after the migration or a rename.

**Migration (WS-2), `server/migrate.js`.** Runs at start-up whenever anything of the old layout is present.
- **Copy phase.** Each flow is built in `flows/.staging-<id>`, verified (every file's size), then renamed into place in one step, so a finished folder is complete by construction. The originals are not touched in this phase.
- **Backup phase.** Every old file and folder, including runs of flows deleted long ago, is moved to `_backup-pre09-<date>/`. A journal resumes the right phase after a crash.
- **A file that stays locked** (antivirus, an editor) stops the start with `MIGRATION_FAILED` and names it. Nothing is half-done.
- **Re-running is safe.** It is idempotent. A restored old file next to a migrated folder only adds what is missing and never overwrites.
- **Checking it first.** `node scripts/check-migration.mjs <copy-of-data>` tries the migration on a copy. On the user's real data it matched every flow, chat, run, version and review.

**Linked folders (WS-8).** `POST /api/flows/link {path, asCopy?}` registers a folder that holds a `flow.json` (`config.json → linkedFlows`). It is used in place, not copied.
- **Allowed paths.** Absolute, local (no `\\server` shares) and an existing directory, checked with its real path. It may not be, be inside, or contain the app's data, the working folders or the installation. A `flow.json` that is a link, or larger than 5 MB, is refused.
- **Trust lives in the app.** `execFingerprint` hashes everything except names, descriptions, slugs and positions.
  - At link time, a flow with anything executable is quarantined (WS-7), as an import is.
  - An outside edit is detected on read, and by a light async poll. If it changes the fingerprint and the flow has executable parts, or its working directory changed, the flow goes back to quarantine. Its runs are stopped, and an automatic version "Antes del cambio externo" keeps the previous definition.
  - An in-app save updates the trust, except while quarantined.
- **Git stays clean.** A save that does not change the definition (runs, chats, memory, pins, the schedule switch) never writes the linked `flow.json`, even one written by hand with another layout. A config edit changes only `flow.json`.
- **Concurrency.** A tab holding data from before an outside edit gets 409 `FLOW_CONFLICT`. A machine-state save racing with an outside edit keeps the outside definition.
- **An unplugged or renamed folder** makes the flow `available:false`: 409 `FLOW_UNAVAILABLE`, left out of the external API, and shown in 🔔. Its schedule and polling pause. Nothing is ever deleted, and it comes back by itself.
- **Ids.** A folder whose id already exists in the app gives `LINK_ID_TAKEN`; with "como copia" it gets a new id, written into its `flow.json`. The same folder twice gives `LINK_EXISTS`.
- **Moving, unlinking, deleting.**
  - `POST /:id/move-to` turns an app flow into a linked one; a target that already has a `flow.json` gives `LINK_TARGET_HAS_FLOW`.
  - `DELETE /api/flows/link/:id[?keepLocalCopy=1]` unlinks. The folder's files are never touched, and the app's side is kept so that linking again brings the history back.
  - Deleting a linked flow removes only the app's side.
- **Import from a folder (WS-4).** `POST /api/flows/import {path}` and `afs import <carpeta>` import a folder's `flow.json` (+ `chats/`) like a bundle: new id, quarantine.
- **Hardening for every flow.** A working directory inside the app's data gives 422 `CWD_IN_DATA`. A break that reloads a step definition never takes one that is quarantined.

**Reveal (WS-9).** `POST /api/flows/:id/reveal` is UI-only: loopback and UI key. The server decides the path (the linked folder or the app's folder) and opens it with `explorer.exe` without a shell. `AFS_REVEAL=0` returns only the path (tests).

**Selector (WS-10).** The flow list has `origin`, `path` and `available`. The selector groups "En esta app" and "Vinculados (carpetas)", marks linked flows with 🔗 and the folder name, and disables unavailable ones. 📂 opens the folder dialog: open the folder in the Explorer, link a folder, move this flow to one, unlink, write README.

**README (WS-11).** `flowReadme` builds the README from the portable definition only:
- **Contents:** name, description, steps (kind, slug, first line of the task), edges, variable **names** and how to run the flow.
- **Never included:** values, memory, runs, tokens, local paths, command or hook bodies.
- **Deterministic**, and it never overwrites a README that does not carry its marker (`README_NOT_OURS`).
- **Where it is written:** in the app's folders on every change; in a linked folder only on request (`POST /:id/readme`).

**Tests.**
- `34-flow-folders` (7): migration of a seeded old layout, crashes in each phase, a locked file, additive re-run, the `flow.json`/`state.json` split with rename at restart, and delete.
- `35-linked-folders` (13): link and quarantine, outside edits (including past character 120, the working directory and Bash access), stop while running, conflict, unplugged folder, path validation, ids, git cleanliness with secrets, move/unlink/relink/delete, import from a folder, reveal and README, `CWD_IN_DATA`.
- `36-ui-flow-folders` (1): the browser flow.

**First adversarial pass.** It found 4 high, 4 medium and 3 low issues, each proved with the harness. All are fixed, each with a regression test (`revisión 09 …` in `35-linked-folders`):
- **(H) Outside edits that add execution were not reviewed.** Agent steps, MCP tools that write and wider permissions were not counted. Now any change to a linked flow that is not *inert* goes to review. Inert means only roles and skills with read-only built-in tools and default permissions, no hooks, no "Al terminar" and no command checks.
- **(H) The working folder's own Claude configuration was not covered.** A commit that only adds `.claude/settings.json`, `.mcp.json`, agents or `CLAUDE.md` changes what Claude does. Now:
  - A first link with its own working directory is reviewed.
  - The trust keeps a hash of that configuration. A change sends the flow back to review before a run (423) and on the next poll.
  - Changing the folder from the app is the person's choice and is trusted.
- **(H) An id that differs only in case** shared another flow's working folder on Windows, and could break the listing. Ids are compared without case, and one bad link can no longer break the listing.
- **(H) A lost or damaged `state.json` failed open.** It lost the quarantine, and the flow fell back to the user's folder. Now:
  - The flow keeps its own folder, and is reviewed when it executes things.
  - The damaged file is set aside.
  - A new flow writes its state before its definition.
- **(M) Swapping step names re-routed a router.** Routes go by name. Step names and edge labels are now part of the fingerprint.
- **(M) Unlinking left the history to any folder that claimed the id.** The app-side history (secrets, memory) is reused only by the same folder it belonged to (`linkedPath`); any other folder needs "como copia".
- **(M) A `flow.json` could turn on automatic source polling.** `watchPolling.enabled` is machine state now, like the schedule switch.
- **(M) A linked flow could take over name-based calls.** A name shared by two flows is no longer resolved by name; use the id.
- **(M) A linked folder swapped for a junction was followed until the next poll.** Its real path is checked on every read and write.
- **(L) Secret values reached the repo.** Variable names like `GH_KEY` and `JIRA_PAT` (and `bearer`, `cookie`, `session`) count as secret now; `issueKey` does not.
- **(L) Small bugs.**
  - The README's "Conexiones" was empty.
  - Linking rewrote a `flow.json` without an id; the registry holds the id now, and the file changes only on the next edit.
  - A very deeply nested `flow.json` broke the listing once; it is `LINK_INVALID` now.
- **New for every flow:** a working directory that is another flow's own folder gives 422 `CWD_OTHER_FLOW` (spec 11).

**Second adversarial pass.** It checked the first pass's fixes and found 2 high, 4 medium and 2 low issues. All are fixed, each with a test (`revisión 09b …`):
- **(H) Any outside edit re-trusted the working folder's Claude configuration.** An outside edit now keeps the reviewed configuration hash. A configuration change that arrives together with a `flow.json` edit is still reviewed. Only "Revisé este flujo" and a change of folder made in the app refresh it.
- **(H) Context sources handed Claude any local folder without review.** This included `../../../.ssh` relative to the flow's own folder, and the app's data. Now:
  - Context sources make a flow non-inert.
  - `WebFetch`/`WebSearch` no longer count as read-only for that decision, because with Read they can carry data out.
  - A source inside the app's data, another flow's own folder or the installation is never handed to Claude: it is marked "NO PERMITIDO", for every flow.
- **(M) A `state.json` that was valid but empty or partial was not seen as lost.** A state without `createdAt` is lost too. Migration gives very old flows `createdAt: 1`, so they stay in the user's folder as before.
- **(M) A linked flow named like another flow's slug took over its calls.** Name and slug matches are now resolved together; two flows means ambiguous, so use the id.
- **(M) Swapping step slugs re-routed `…/steps/<slug>/run`.** Slugs are part of the fingerprint now, derived the same way when the file has none.
- **(M) "Desvincular" with "dejar una copia" on an unavailable folder kept nothing.** It uses the last definition the app saw, or refuses with `FLOW_UNAVAILABLE`.
- **(M) An import with a working directory or context sources was not reviewed.** It is now, for bundles and folders alike.
- **(L) "Revisé este flujo" enabled what was on disk at click time.** The UI sends the revision it showed, and a newer one gives 409.
- **(L) Each outside edit kept a version forever.** These versions are now automatic, so they are pruned.

**Accepted limits.**
- The configuration hash covers the files Claude reads from the working folder: `.claude/` settings, agents, skills, commands and hooks, `.mcp.json` and `CLAUDE.md`. It does not cover scripts those files call elsewhere in the repo, `CLAUDE.md` in parent folders, or `@imports`. A repo whose hooks run its own scripts is trusted as a whole when you review it.
- A working directory that *contains* the app's data (for example the user's folder of an older flow) is allowed, as before.

**Closing check.** It confirmed that the 9 fixes of the second pass hold, and found no regression for ordinary flows. It found two medium issues, both fixed with a test (`revisión 09c`):
- **A file source gave Claude the file's whole folder, even one containing the app's folders** (for example a file in the user's folder). Such a file is now "NO PERMITIDO", with a hint to move it.
- **A step or general chat of a linked flow skipped the configuration check.** The check now lives in the quarantine guard, so every path that starts Claude in the flow's folder applies it: runs, chats, `/ask` and the review.

Two behaviour changes, by design:
- Importing a flow that has a working directory or context sources is reviewed, even your own export on the same machine.
- A context source inside the app's installation (for example `<install>/docs`) is "NO PERMITIDO".

The user's real flows are not affected: their working directories and context sources are outside the app's folders.

Spec 09 is closed. It went through an architect review, two adversarial passes and a closing check, and has a real simulation with the real Claude CLI.
- **Your data.** A copy of your data migrated with every flow, run, version and chat intact, and the 4 flows open and export.
- **A linked flow in a git repo.** Claude ran it and the repo stayed clean. A commit that gave it Bash sent it to review, and after the review it ran again. An edit in the app changed only `flow.json`.

**Deferred.**
- Moving `flow-skills/` and `context-files/` into the flow folder.
- Skills committed inside a linked repo (they would need trust coverage).
- A working directory relative to a linked folder.
- `INVOKE.md` in linked folders, and an option to keep memory in the repo.
- A diff view in the review banner (the "Antes del cambio externo" version covers rollback).
- Renaming folders while running, or renaming linked folders.
- Network shares, `fs.watch`, and zip export.

## Implementation notes (2026-11-12)

**Bundle format.** `<slug>.afsflow.json` = `{format: "agent-flow-studio/flow", version: 1, exportedAt, app, flow, removed[], chats?, runs?}`.

**What travels and what doesn't.**
- Requirements (spec 23), context sources (spec 21), "Al terminar" (spec 22), assertions and breaks are part of `flow`, so the recipient sees what the flow needs before running it.
- Never exported: Claude sessions, last runs and pins (pins unless asked), the API token and the UI key.
- Secret-looking variable values are blanked unless asked.
- The schedule is exported disabled.

**Import.**
- An import always creates a new flow. If the name already exists it gets " (importado)".
- The flow is sanitized exactly like a UI save, and its machine state is cleared.
- An initial version "Importado" is saved.
- Chats and runs come along when present.

**Quarantine (WS-7).** Any imported flow with something that would run on the importer's machine is quarantined: command steps, hooks, "Al terminar", command assertions, steps with Bash/Edit/Write, `bypassPermissions`, or requirement check commands.
- Blocked while quarantined: runs (UI, single step, API, dry run, chat-triggered, schedule), step and general chats, and `/ask`, all with **423 `QUARANTINED`** and the reasons.
- A save cannot remove the quarantine. Only **"Revisé este flujo, habilitar"** (`POST /api/flows/:id/trust`) lifts it.

**CLI.** `afs export <flujo> [-o file] [--chats] [--runs] [--no-memory]` and `afs import <file>`. Both are local only and use the UI key.


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
