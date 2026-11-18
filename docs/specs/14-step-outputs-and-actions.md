# 14 — Step outputs: handoff, actions and deliverables

**Status:** Implemented v1 (2026-11-18; e2e `test/e2e/29-outputs.test.mjs`). Handoff (section 2) and detected actions (3.4) come from [spec 15](15-data-passing.md). Declared actions (3) and native deliverables (4) are in v1. What v1 leaves out is listed at the end ("Implementation v1").

## Summary

A step can produce three kinds of results. This spec makes each one explicit, configurable and visible:

| Kind | Example | Today |
|---|---|---|
| **Handoff:** information for the next steps | "Risks found: …", or a JSON list of test cases | Plain text only |
| **Actions:** changes in external systems | Create a sub-task in the Jira ticket being analysed; create a bug in project SBK | Only when the prompt or a hook happens to do it |
| **Deliverables:** documents or files in a given format | A Markdown report, `.feature` files, an xlsx test matrix, a Confluence page, a Word or PDF document | Not supported |

What a step does can be **defined by the skill itself** (the skill declares its actions and outputs) or **by the step** (the flow author configures them). Step settings override skill defaults.

## Goals
- Look at a step and see what it **receives**, what it **changes** and what it **produces**.
- Pass structured data between steps, not only free text.
- Make side effects explicit, reviewable and safe: least privilege, optional approval, no duplicates on re-run.
- Produce real files in the formats teams use, and make them reachable from the UI, the API and CI.

## Non-goals
- A general workflow engine for external systems. Actions stay thin and use Claude Code's MCP tools.
- Converting every format natively. Complex formats are delegated to skills the user already has, such as `docx`, `pdf` and `xlsx`.

---

## 1. Where the definition comes from

### 1.1 Skill-defined (the skill decides)

A skill may ship a sidecar file `afs.json` next to `SKILL.md`. It is optional, and Claude Code ignores it. The file declares what the skill needs and produces:

```jsonc
{
  "access": "atlassian",                       // access preset the skill needs (spec 02)
  "inputs":  { "issue": "Jira key of the ticket being analysed" },
  "handoff": { "format": "json", "schema": { "type": "object", "properties": { "cases": { "type": "array" } } } },
  "actions": [
    { "id": "subtask", "type": "jira.createSubtask", "parent": "{{vars.issue}}", "summary": "QA: {{step.name}}", "approval": "confirm" }
  ],
  "deliverables": [
    { "id": "cases", "format": "feature", "path": "tests/{{vars.issue}}.feature" }
  ]
}
```

- If there is no `afs.json`, the app falls back to the skill's `allowed-tools` front matter to suggest an access preset.
- When a user picks a skill for a step, these declarations **pre-fill** the step. The UI marks them "from skill", and they can be overridden.
- If the skill itself already performs the action in its instructions (e.g. "create a sub-task with the findings"), the step only needs the right **access**. The action then shows as *skill-managed* (see 3.4).

### 1.2 Step-defined (the flow author decides)

The same three blocks (`handoff`, `actions`, `deliverables`) can be configured on any step, including role, agent and command steps, in a new **Outputs** section of the step panel.

**Precedence:** step setting > skill `afs.json` > defaults (text handoff, no actions, no deliverables).

---

## 2. Handoff (pass information to the next step)

| ID | Requirement |
|---|---|
| HAND-1 | `handoff.format`: `text` (default), `markdown` or `json`. |
| HAND-2 | With `json`, an optional JSON Schema can be set. The app extracts the JSON from the answer and validates it. If it fails, it retries once with the validation error. If it still fails, the step errors. |
| HAND-3 | Downstream steps can reference fields: `{{steps.Design cases.output.json.cases}}`. In hooks: `ctx.upstream['Design cases'].json`. |
| HAND-4 | `handoff.summary` (on/off): when the output is long, a short summary is generated for downstream prompts, while the full output stays available. This keeps the context small. |
| HAND-5 | The node and the panel show the output format and, for JSON, the top-level keys. |

---

## 3. Actions (changes in external systems)

### 3.1 Built-in action types (v1)

| Type | Parameters | Tooling |
|---|---|---|
| `jira.comment` | `issue`, `body` | Atlassian MCP `addCommentToJiraIssue` |
| `jira.createSubtask` | `parent`, `summary`, `description`, `fields?` | `createJiraIssue` (issue type Sub-task, with a parent) |
| `jira.createIssue` / `jira.createBug` | `project`, `issueType`, `summary`, `description`, `fields?` (e.g. `environment: "QA, PPD"`, labels, components) | `createJiraIssue`, plus `getJiraIssueTypeMetaWithFields` to map required fields |
| `jira.link` | `from`, `to`, `type` | `createIssueLink` |
| `jira.transition` | `issue`, `to` | `getTransitionsForJiraIssue` + `transitionJiraIssue` |
| `confluence.createPage` / `confluence.updatePage` | `space`, `parent?`, `title`, `body` or `fromDeliverable` | `createConfluencePage` / `updateConfluencePage` |
| `git.commit` | `paths`, `message`, `branch?`, `push?` | Shell (`git`) in the flow working directory |
| `http.post` | `url`, `body`, `headers?` | Server-side fetch (e.g. a Slack or Teams incoming webhook, Jenkins) |
| `flow.invoke` | `flow`, `step?`, `input` | Spec 11 cross-flow call |

### 3.2 Requirements

| ID | Requirement |
|---|---|
| ACT-1 | Actions run **after** the step's main work succeeds, in the declared order. Each action has `when: success (default) \| failure \| always`. |
| ACT-2 | Parameters support templates, including the step's own output: `{{output}}` and `{{output.json.x}}`. |
| ACT-3 | Each Jira or Confluence action runs as a **constrained Claude call** (Haiku), allowed **only the MCP tools that action needs**, with a strict JSON result `{ok, key/id, url}`. The app, not the model, decides what to call. The model only fills the MCP payloads. |
| ACT-4 | **Approval mode** per action: `auto`, `confirm` or `dryRun`. With `confirm`, the run pauses that action, and the UI (or the external API caller) gets a card showing the exact payload with Approve / Edit / Skip. Runs invoked externally with `confirm` actions return `status: waiting_approval`. With `dryRun`, the payload is shown but nothing is created. **Default: `confirm` for create and transition actions, `auto` for comments.** |
| ACT-5 | **Idempotency:** each action records what it created (`{actionId, runInputHash, key, url}`) in the step state. On a re-run with the same input, the default is *update or skip* instead of creating a duplicate (e.g. it won't create a second sub-task). It can be forced with `allowDuplicate: true`. |
| ACT-6 | Action results are appended to the handoff as an `actions` block (`[{id, type, key, url, status}]`), so downstream steps know e.g. the bug key that was just created. |
| ACT-7 | Results appear in Activity and in the run summary (spec 06), and as clickable links on the node. |
| ACT-8 | A failed action marks the step `error` unless `optional: true`. |
| ACT-9 | When actions are added, the app warns if the step's access is insufficient, and offers a scoped preset that adds only the needed tools. |

### 3.3 Example: "analyse a ticket, then create a QA sub-task and a bug"

```jsonc
"actions": [
  { "id": "qa-subtask", "type": "jira.createSubtask", "parent": "{{vars.issue}}",
    "summary": "QA analysis – {{vars.issue}}", "description": "{{output}}", "approval": "auto" },
  { "id": "bug", "type": "jira.createBug", "when": "success", "if": "{{output.json.defects.length}} > 0",
    "project": "SBK", "summary": "{{output.json.defects.0.title}}",
    "fields": { "environment": "QA, PPD" }, "approval": "confirm" }
]
```

### 3.4 Skill-managed actions

When the skill performs actions itself through its tools, the app cannot declare them in advance. Instead it **detects** them: Jira and Confluence write tools seen in the run's `tool_use` events are listed as "Actions performed" with their results. The same idempotency warning appears on re-run ("this skill created SBK-456 last time"). Flow authors who want control and approval should move the action from the skill to declared actions.

---

## 4. Deliverables (documents and files)

| ID | Requirement |
|---|---|
| DLV-1 | A deliverable has `{id, format, path, destination[], from?}`. `path` supports templates. `from` is `output` (default), a JSON field, or a prompt instruction ("a test matrix with one row per case"). |
| DLV-2 | **Formats:** `md`, `txt`, `json`, `csv`, `html`, `feature` (Gherkin), `junit-xml`, `yaml` are produced natively. `docx`, `pdf`, `xlsx` and `pptx` are produced by delegating to the user's matching skill (`docx`, `pdf`, `xlsx`, `pptx`), with Write access confined to the output folder. |
| DLV-3 | Files are written to `<flow folder>/runs/<runId>/outputs/<step-slug>/` (spec 09), and the run lists them with size and hash. |
| DLV-4 | **Destinations** (several allowed): `run` (default, always), `path` (copy to a folder, e.g. a repo's `tests/`), `confluence` (page created or updated from md or html), `jira` (comment with the content or a link). Jira attachments depend on MCP support; see the open questions. |
| DLV-5 | Downstream steps receive the file paths in the handoff (`files: [{id, path, format}]`), and command steps get them in `STEP_FILES`. |
| DLV-6 | **Access:** the UI shows files in the step and run views with preview (md, html, json, csv) and download. The external API serves `GET /api/ext/flows/:flow/runs/:runId/files/:fileId`, so CI can archive them as build artifacts. `afs run --out <dir>` downloads them. |
| DLV-7 | A format check runs before a file is marked produced: JSON and YAML must parse, Gherkin must have `Feature:` and `Scenario`, and JUnit XML must be well-formed. If the check fails, the step retries once. |
| DLV-8 | Deliverable templates are allowed: a template file (Markdown or HTML with `{{…}}`) from the flow folder or the skill folder fills the structure, and the model fills the content. |

**Example: test design step**

```jsonc
"deliverables": [
  { "id": "gherkin", "format": "feature", "path": "{{vars.issue}}.feature", "destination": ["run", { "path": "C:/repos/sbk-tests/features" }] },
  { "id": "matrix",  "format": "xlsx", "path": "{{vars.issue}}-matrix.xlsx", "from": "Coverage matrix: case, rule, priority, type" },
  { "id": "report",  "format": "md", "path": "report.md", "destination": ["run", { "confluence": { "space": "QA", "parent": "123456" } }] }
]
```

---

## 5. UI

**Step panel → new "Outputs" tab**, with three collapsible blocks:
- **Passes to next step:** format selector, optional schema, summary toggle.
- **Actions:** a list with "＋ Add action" (type picker, a templated form per type, approval mode, when, optional).
- **Files:** a list with "＋ Add file" (format, path, destinations).

Skill-provided entries carry a "from skill" chip and a "reset to skill default" link.

**Node badges:** 📤 handoff format · ⚡ number of actions · 📄 number of deliverables. After a run, links to created Jira keys and pages appear on the node.

**Approval cards:** shown in Activity and in the general chat, and listed under a "Pending approvals" counter in the top bar.

## 6. Data model additions (step)

```jsonc
"handoff": { "format": "text", "schema": null, "summary": false },
"actions": [ { "id", "type", "params": {}, "when": "success", "if": null, "approval": "confirm", "optional": false, "allowDuplicate": false } ],
"deliverables": [ { "id", "format", "path", "from": "output", "destination": ["run"], "template": null } ]
// state.json (machine-bound): "actionLedger": [ { "actionId", "inputHash", "key", "url", "at" } ]
```

## Acceptance criteria
- A skill whose `afs.json` declares a `jira.createSubtask` action pre-fills that action when the skill is selected. Running it on `SBK-123` creates one sub-task. Re-running with the same input does not create a second one.
- A `jira.createBug` action with `approval: confirm` pauses with the exact payload (project, summary, Environment "QA, PPD"). Approving creates the bug, and its key reaches the next step's handoff.
- A step with `handoff.format: json` and a schema fails clearly when the model's output does not validate after one retry.
- A `feature` deliverable is written to the run's outputs folder, copied to the configured repo path, and downloadable via the external API.
- An `xlsx` deliverable is produced through the user's `xlsx` skill, and the file opens correctly.

## Open questions
- **Jira attachments:** the current Atlassian MCP has no attachment upload tool. Options: link to the file served by the app, publish to Confluence and link, or upload with a personal API token (needs secret storage).
- **Claude Artifacts / Docs:** publishing to claude.ai artifacts is not available from the headless CLI. Proposed for v1: HTML deliverables plus Confluence. Revisit if a connector becomes available.

## Implementation v1 (2026-11-18)

Module `server/outputs.js`. The engine applies a step's deliverables and actions after its own work (`applyOutputs` in `executeStep`), also for each element of a "para cada".

**📄 Deliverables** — `step.deliverables[] = {id, format, path, from, destination?: [{path}]}`
- Formats: `md`, `txt`, `json`, `csv` (a JSON list becomes rows), `html`, `feature`, `yaml` and `junit-xml`.
- `from` is `output` or `json.<field>`. `path` is a template, and only its base name is used.
- Written to `data/outputs/<flow>/<run>/<step>/`. The files list them with size and hash, and they go into the handoff (`files`, `STEP_UPSTREAM`).
- Format check (DLV-7) before writing: JSON parses, `.feature` has Feature + Scenario, JUnit XML opens and closes `<testsuite(s)>`. If it fails, the step fails with `DELIVERABLE_INVALID`. There is no retry with the model in v1.
- Destinations: an existing absolute folder. Skipped in a rehearsal.
- Download:
  - UI: `GET /api/flows/:id/runs/:runId/files/:name|:id`.
  - External API: `GET /api/ext/flows/:flow/runs/:runId/files/:name|:id`. Only files inside the run's outputs folder.

**⚡ Declared actions** — `step.actions[] = {id, type, params, when, if?, approval, optional?, allowDuplicate?}`
- Types:
  - Jira: `jira.comment`, `jira.createSubtask`, `jira.createIssue`, `jira.transition`, `jira.link`.
  - Confluence: `confluence.createPage`, `confluence.updatePage`.
  - Other: `http.post`.
- Params are templates: vars, steps, item, `{{output}}` and `{{output.json.x}}`. `if` is a condition like an arrow's (`{type:'json', path, op, value}`…).
- **How a Jira or Confluence action runs** (ACT-3):
  - A Claude call (Haiku; `config.actions.model` overrides it) allowed ONLY that action's MCP tools, plus `ToolSearch` to load them.
  - Bash, Edit, Write and Web are disallowed, and there is no session.
  - The data goes inside `<untrusted-data>`, one field per heading.
  - **The app checks that the write tool was really called.** A model that only says "done" is a failed action. It answers `{ok, key, url}`.
- **HTTP POST**: a server-side fetch. Redirects are not followed, and a credential is only sent to its own origin (the same rule as spec 10).
- **Approval** (ACT-4): `auto` (the default for `jira.comment`), `confirm` (the default for everything else) or `dryRun`.
  - **The run never waits for a confirmation.** The action stays `awaiting_approval` in the step's Data tab (Aprobar / Editar y aprobar / Rechazar). It shows as ⏳⚡ on the node and as a ⚡ item in the attention list.
  - It can also be decided through `POST /api/flows/:id/runs/:runId/actions/decide` (and `/api/ext/…`) with `{stepKey, actionId, approve, params?}`.
  - Consequence: the following steps only get the keys of `auto` actions. The handoff `actions` includes them.
- **Idempotency** (ACT-5): a ledger in `data/actions/<flow>.json` keyed by actionId + hash of the rendered payload. A re-run with the same input gives `exists` ("ya se hizo en r_…"). An approval checks the ledger again with the final payload.
- **Failure** (ACT-8): a failed action fails the step (`ACTION_FAILED`) unless `optional`.
- **Safety:**
  - The `noExternalWrites` policy blocks every action.
  - A rehearsal turns every action into `dryRun`.
  - An imported flow with actions, or with deliverable destinations, is quarantined.

**UI**
- Step config: a "⚡ Acciones y 📄 entregables" box with a form per action type, approval, when and optional.
- Data tab: deliverables with download links, and declared actions with status and the approval buttons.
- Node badges: ⚡N, 📄N, and ⏳⚡ while an action waits.

**Not in v1:**
- The skill sidecar `afs.json` (1.1).
- `docx`/`xlsx`/`pdf`/`pptx` through the user's skills.
- Deliverable templates (DLV-8).
- Confluence or Jira as deliverable destinations (DLV-4). A `confluence.createPage` action with `{{output}}` covers the common case.
- `git.commit` and `flow.invoke` actions.
- `afs run --out`.
- A paused run waiting for an approval (ACT-4's `waiting_approval`). The run never waits; the action is decided afterwards.
