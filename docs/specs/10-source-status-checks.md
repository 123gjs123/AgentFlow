# 10 — Source status checks ("pull for news")

**Status:** Implemented (2026-11-18; e2e: `test/e2e/28-watch.test.mjs`). In the app it is called **🔔 Novedades**. See "Implementation" at the end for the differences from the proposal.

## Summary

A step can declare one or more **sources**: the external things its work depends on, such as a Jira issue or JQL query, a git branch, a build artifact, a Confluence page or page tree, a file, a command, or "whatever tools this step already uses". A **Status** button pulls each source, compares it with the last snapshot and reports **what is new**. When there is news, the user (or an automation rule) decides whether to re-run the step or the flow.

## Goals
- Answer "did anything change since last time?" for every step in one click.
- Precise, explainable diffs ("SBK-123: status In Progress → Done; 2 new comments").
- Cheap: deterministic checks wherever possible, and a model call only when the source needs MCP access.
- Optional automation: poll on an interval and re-run on change.

## Non-goals
- Real-time push from Jira or Bitbucket. Webhooks into `/api/ext` already cover push (spec 06).
- Full content diffing of large documents (summaries only).

## Requirements

| ID | Requirement |
|---|---|
| SRC-1 | Each step has a **Sources** section listing 0..n sources: `{id, type, target, options}`. |
| SRC-2 | Targets support templates (`{{vars.issue}}`), so one flow can follow different tickets or branches through variables. |
| SRC-3 | **Status** buttons: one per step (checks that step's sources) and one in the top bar (checks all steps). The external API exposes the same check (`POST /api/ext/flows/:flow/status`, optionally `step`). |
| SRC-4 | Each check stores a **snapshot** (`items: {id → version}`) and reports `added`, `changed` and `removed` items with a one-line description each. |
| SRC-5 | Result states: `new` (changes found), `same`, `error` (with the message), `first` (first snapshot, baseline only). |
| SRC-6 | Canvas nodes show a 🔔 badge with the change count when the last check found news. Opening the step shows the diff. |
| SRC-7 | Per source, an **on change** action: `notify` (default), `run_step`, `run_from_step` (the step and everything downstream) or `run_flow`. The change summary is passed as input. |
| SRC-8 | Optional **polling** per flow: check all sources every N minutes. A poll that finds news triggers the on-change actions. |
| SRC-9 | Snapshots and results persist in the flow folder (`sources.json`, spec 09). |
| SRC-10 | Status checks never write anything to the external systems. The AI-based checks run with read-only tools. |
| SRC-11 | Picking a source type shows guidance and an example target. If the step already uses a matching tool (e.g. its access preset includes Atlassian), the UI suggests the matching type. |

## Source types

| Type | Target examples | How it checks | Item id → version |
|---|---|---|---|
| `jira` | `SBK-123` · `SBK-123, SBK-124` · JQL `project = SBK AND fixVersion = "2026.11"` | Claude (Haiku) with read-only Atlassian MCP tools returns strict JSON. The app does the diff. | issue key → `updated` + status + comment count |
| `confluence` | page id or URL · several ids · `tree:<pageId>` (page and descendants) · CQL | Claude with read-only Atlassian tools (getConfluencePage, descendants, CQL) | page id → version number |
| `git` | `C:\repo` + branch `develop` (local) · or a remote URL + branch | `git fetch` then `git rev-parse origin/<branch>`. New commits are listed with `git log old..new --oneline`. No model call. | branch → head sha (+ commit list) |
| `url` (artifact) | Jenkins artifact or build URL, Nexus/Artifactory file, any HTTP resource | HTTP `HEAD` (ETag / Last-Modified / Content-Length), falling back to a `GET` with a content hash. No model call. | URL → etag or hash |
| `file` | path or glob (`reports/*.xml`) | mtime + size, plus a hash for small files. No model call. | path → hash |
| `command` | any shell command (e.g. `az pipelines runs list …`) | Runs it; the stdout hash is the version. If the output is JSON lines or an array with `id`, items are diffed one by one. | line/item → hash |
| `ai` ("this step's tools") | free text: what to watch, e.g. "open bugs linked to SBK-123" | Claude with **the step's own allowed tools**, forced read-only, returns the same strict JSON item list. | model-defined id → version |

### AI-based check contract

For `jira`, `confluence` and `ai`, the model is asked to return only:

```json
{"items":[{"id":"SBK-123","version":"2026-11-10T14:02:11Z|Done|7","title":"Login fails on …","url":"…"}]}
```

The app, not the model, compares this list with the previous snapshot. This keeps diffs deterministic, cheap (Haiku, no reasoning needed) and auditable. The raw tool calls are visible in the step's Activity like any other run.

## Data model

```jsonc
// step.sources (in flow.json)
[{ "id": "src_1", "type": "jira", "target": "{{vars.issue}}", "onChange": "run_step" },
 { "id": "src_2", "type": "git", "target": "C:\\repos\\sbk-api", "options": { "branch": "develop" }, "onChange": "notify" }]

// sources.json
{ "src_1": { "checkedAt": 1731250000000, "state": "new",
             "snapshot": { "SBK-123": "2026-11-10T14:02:11Z|Done|7" },
             "changes": [{ "kind": "changed", "id": "SBK-123", "text": "status In Progress → Done; 2 new comments" }] } }
// flow.json
"sourcePolling": { "enabled": false, "everyMinutes": 30 }
```

## UI
- **Step → Sources tab:** list of sources, an "add source" picker with types, target field with hints, an on-change selector, "Check now", and the last result with its diff.
- **Top bar:** a "🔄 Status" button runs every check in parallel (limit 3). A results drawer shows per-step news, with actions "Run step", "Run from here" and "Dismiss".
- **Flow settings:** polling toggle and interval.

## Acceptance criteria
- Adding a `git` source on a local repo and pressing Status gives `first`. After a new commit is pushed to the branch, the next check gives `new` and lists the commit.
- A `jira` source on an issue whose status changed reports the transition. Unchanged issues report `same` without listing items.
- A `confluence` `tree:<id>` source reports an edited child page by title and version.
- A `url` source pointing at a Jenkins `lastSuccessfulBuild` artifact reports a change after a new build.
- With `onChange: run_step`, a detected change starts a run with trigger `source`, and the change summary is the input.
- Status checks never call write tools. Denied write attempts appear as denials.

## Implementation (2026-11-18)

**Names.** "Sources" was already 📎 Context (spec 21), so here everything is called "watch":
- the step field is `step.watches`;
- the module is `server/watch.js`;
- the state lives in `data/watch/<flowId>.json`;
- polling is configured in `flow.watchPolling`;
- the UI calls it "🔔 Novedades".

The flow-folder storage of spec 09 does not exist yet.

| Requirement | How it is implemented |
|---|---|
| SRC-1 | `step.watches[] = {id, type, target, options?: {branch, credential, fetch:false}, onChange}`. The server sanitises it on save: unknown types are dropped and there are at most 20 per step. |
| SRC-2 | Targets render `{{vars.x}}`. A command target also takes `{{cred.x.y}}`, which travels in an environment variable like in command steps. |
| SRC-3 | Three ways to check:<br>• **"Comprobar ahora"** per step.<br>• **🔔 Novedades** in the top bar (all steps; shown when some step has watches).<br>• `POST /api/ext/flows/:flow/status` (`step` in the body or the query). In the UI API: `GET /api/flows/:id/watch`, `POST …/watch/check {stepId?, watchId?}` and `POST …/watch/ack {stepId?}`. Only one check runs per flow at a time; a second request gets the same result. |
| SRC-4/5 | States `first`, `same`, `new` and `error`.<br>• An error keeps the previous snapshot, so the next good check compares against it.<br>• Changing the target, the type or the branch takes a new `first`.<br>• The changes accumulate in `pending` (up to 100) until **✓ Visto**. |
| SRC-6 | The node shows 🔔 N when news are pending, and 👀 N (the number of watches) when there is nothing new. The 🔔 attention list (spec 27) has a `news` item that opens the step, and there is an OS notification. |
| SRC-7 | `notify`, `run_step`, `run_from_step` or `run_flow`. The strongest action wins, with one run per check, and the summary of the changes is its input (`trigger: 'source'`). If the flow is already running nothing starts, and the result says so.<br>**`run_from_step` is new in the engine:** `startRun({from})` runs that step and everything after it, and the steps before it are not re-run (they pass their last output). `POST /api/flows/:id/run {from}` takes it too. |
| SRC-8 | `flow.watchPolling {enabled, everyMinutes}`: at least 5 minutes, default 30. It is set in the flow's configuration under "🔔 Revisar novedades". |
| SRC-10 | Never writes outside: `git fetch` only updates the local clone's remote refs. Jira, Confluence and ai checks:<br>• use Haiku (`config.watch.model` overrides it);<br>• get only the Atlassian read tools, or the step's tools filtered to read-only;<br>• have `Edit Write MultiEdit NotebookEdit Bash` disallowed and no session (`noPersist`);<br>• treat the target as untrusted data. |
| SRC-11 | Picking a type shows an example target and what the check does. |

**How each type checks**

| Type | Check | Diff text |
|---|---|---|
| `git` | `fetch origin <branch>` (if there is an origin and `fetch` is not false), then the head of `origin/<branch>`, or the local branch. | "N commit(s) nuevo(s) — …" with `git log old..new` |
| `url` | HEAD for ETag / Last-Modified; without them, GET and a hash of the content. Optional credential: Basic with user+token, or Bearer with token. | |
| `file` | Path or glob relative to the flow's folder; a hash for files under 2 MB, size+mtime above that. | |
| `command` | Its stdout. A JSON array, or JSON lines with `id`/`key`/`name`, is compared element by element; any other text is one item. | First new line |
| `jira` | The version is `updated|estado|comentarios`. | "estado A → B; N comentario(s) nuevo(s)" |
| `confluence` | | "versión A → B" |

**Not done:** history beyond the pending list, and per-source "dismiss" in a drawer. ✓ Visto acts per step.
