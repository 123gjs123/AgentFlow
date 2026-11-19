# 12 — Per-step external invocation

**Status:** Implemented v1, closed after architect + 4 adversarial passes. Running a single step via `step=` already worked (spec 06).

## Summary

Every step tells the user **exactly how to invoke it from outside**, for example a Jenkins stage on a build server that, after deploying, calls the "Run sanity tests" step, or the whole flow. Each step gets a stable address, copy-ready snippets for common callers and an entry in the flow's generated `INVOKE.md`.

## Goals
- Any step is callable from CI, scripts, schedulers, webhooks and Claude Code, without reading docs.
- Choice of scope: just this step, or this step and everything after it.
- Snippets that work as pasted: real host, port, flow and step names, and the right token.

## Requirements

| ID | Requirement |
|---|---|
| STEPINV-1 | Each step has a stable **slug** (derived from its name and editable). Steps are addressable by id, name or slug. |
| STEPINV-2 | New endpoint `POST /api/ext/flows/:flow/steps/:step/run`, with the same body and options as a flow run plus `mode: only (default) \| from`. `from` runs the step and all its downstream steps. |
| STEPINV-3 | `afs run <flow> --step <step> [--from]` and the MCP `run_flow` tool's `step` and `from` arguments map to the same behaviour. |
| STEPINV-4 | **Step → Invoke tab**, with tabs: Jenkins (Jenkinsfile stage for Windows `bat` and Linux `sh`), curl, PowerShell, `afs` CLI, webhook URL, Claude Code (MCP prompt), GitHub Actions / Bitbucket Pipelines. |
| STEPINV-5 | Snippets use the **per-flow token** (spec 11), read from a CI credential or env var (`AFS_TOKEN`) rather than embedded in the script. The token can be revealed and copied separately. |
| STEPINV-6 | Snippets handle the remote case: if the server is bound to loopback only, the tab warns that a remote Jenkins can't reach it and explains `HOST=0.0.0.0` plus the firewall and VPN considerations. |
| STEPINV-7 | The step's input contract is shown above the snippets: what `input` means for this step, which `vars` it reads (detected from `{{vars.x}}` usage), and what it outputs. |
| STEPINV-8 | Sync and async usage both work. For long steps the snippets poll `GET …/runs/:runId` until done, then fail the CI stage if the status is not `success`. |
| STEPINV-9 | `INVOKE.md` in the flow folder is regenerated on every save. It lists the flow and each step with endpoint, CLI and Jenkins examples, with the token as a placeholder. |
| STEPINV-10 | Runs started this way record `trigger` from `source` (e.g. `jenkins`), and the run list shows it. |

## Example: Jenkins on another server

```groovy
stage('Post-deploy sanity (Agent Flow Studio)') {
  environment { AFS_TOKEN = credentials('afs-release-check-token') }
  steps {
    sh '''
      set -e
      RES=$(curl -sf -X POST "http://qa-box:4317/api/ext/flows/release-check/steps/run-sanity/run" \
        -H "Authorization: Bearer $AFS_TOKEN" -H "Content-Type: application/json" \
        -d "{\\"input\\":\\"$BUILD_URL\\",\\"vars\\":{\\"build\\":\\"$BUILD_NUMBER\\"},\\"source\\":\\"jenkins\\",\\"mode\\":\\"from\\",\\"wait\\":true,\\"timeoutSec\\":1800}")
      echo "$RES" | jq -r .result
      test "$(echo "$RES" | jq -r .status)" = "success"
    '''
  }
}
```

## Example: script on the same machine

```powershell
afs run "release-check" --step "run-sanity" --from -i $env:BUILD_URL --var build=$env:BUILD_NUMBER
if ($LASTEXITCODE -ne 0) { throw "Sanity failed" }
```

## Acceptance criteria
- From a step's Invoke tab, a pasted curl command runs only that step and returns its output.
- With `mode: from`, the step and its downstream steps run, and the upstream steps are not re-run (they use their last outputs).
- A Jenkins stage using the snippet fails when the step fails.
- `INVOKE.md` lists every step after adding or renaming one.

## Implementation (v1)

**Slugs (STEPINV-1)**
- `step.slug` is assigned once, from the name and unique in the flow (`store.ensureSlugs` on every save). Renaming a step does not change its slug, so callers do not break.
- It can be edited from the Invoke tab. An explicit slug is normalised. An invalid one is rejected (`BAD_SLUG`), and so is a repeated one (`STEP_SLUG_TAKEN`). In a hand-edited or imported file, a repeated or invalid slug is replaced.
- `store.findStep` resolves a step by id, then exact slug, then case-insensitive name. A name shared by two steps returns `STEP_AMBIGUOUS` (409). Steps without a saved slug still resolve through the slug of their name.
- Flows also resolve by the slug of their name when it is unique: `/flows/release-check/...`.

**Endpoint (STEPINV-2)**
- `POST /api/ext/flows/:flow/steps/:step/run` and `POST /flows/:flow/run` with `step` share one handler.
- `scope: only | from` is the field name, because `mode` already names wait/async in the generated clients. `mode: only|from` and `from: true` are also accepted.
- `from` runs the step and everything after it. Steps before it pass their last good output, or `FROM_UPSTREAM_MISSING` is returned (409).
- The dry run lists the steps that would run and reports `fromProblem`. External checks such as raw templates only look at the steps that will run.
- The summary carries `scope` and `scopeStep`, and its `result` comes from the final steps of the "from" set.

**CLI and MCP (STEPINV-3)**
- `afs run <flow> --step <s> --from`
- MCP `run_flow` takes `{ step, from: true }`.
- The generated clients (`afs_call.py`, `afs-call.ps1`) accept `--scope` / `-Scope`. The Jira and webhook bodies carry `scope`.

**Invoke tab (STEPINV-4 to 8)**
- The step panel has a 🔌 Invocar tab. `GET /api/flows/:id/steps/:step/invoke?scope=` builds the content on the server (`integrations.stepInvoke`):
  - the contract: whether the step uses `{{input}}`, the `{{vars.x}}` it reads, the steps before it whose last output it uses, the steps that run, the output format, deliverables, and ⚡ external writes;
  - snippets for curl (wait), curl (poll), PowerShell (poll), Jenkins `sh` and Jenkins Windows (`powershell` step instead of `bat`, which avoids quoting problems), `afs`, Claude Code (MCP) and webhook.
- Values are quoted with the same `bashLit`/`psLit`/`groovyTriple` helpers as spec 17.
- The token is never in a snippet: they read `AFS_TOKEN`. The tab can reveal and copy the token separately.
- The remote base and the "not reachable yet" warning come from `reachability()`, including the `HOST=0.0.0.0` and firewall advice.
- GitHub Actions, Bitbucket, GitLab and Jira come from the spec 17 assistant, embedded with this step and scope already filled in.

**INVOKE.md (STEPINV-9)**
- `GET /api/flows/:id/invoke.md` returns it. `data/invoke/<flow>.md` is rewritten 300 ms after any change to the flow, only when its text changes, and it is deleted with the flow.
- It lives under `data/invoke/` until spec 09 gives flows their own folder.

**Run list (STEPINV-10)**
- The trigger already came from `source`. The run list now also shows "desde <step>".

**Left for spec 11:** the per-flow token (STEPINV-5). Snippets use the installation token through `AFS_TOKEN`.

Tests: `30-step-invoke` (5 tests). The pasted PowerShell snippet is actually executed, and it fails when the step fails.

### Review fixes (architect + adversarial, pass 1)

**Slugs are server-managed now**
- The flow save (`PUT /api/flows/:id`) never changes a slug:
  - existing steps keep theirs, across renames, other tabs, undo and old clients;
  - new steps (duplicated boxes, "Mis steps") get a free one.
- Only `PUT /api/flows/:id/steps/:stepId/slug` edits a slug. The client treats `slug` as a server field in merge and history, and the Invoke tab reads it from the server.
- A version restore keeps the live slugs.

**Step resolution**
- A slug never equals another step's id. `findStep` resolves ids first, so a snippet could otherwise run another step.
- A ref that is one step's slug and another step's name returns `STEP_AMBIGUOUS`. Example: a renamed "Deploy" plus a new "Deploy".

**"From" runs and checks**
- `fromProblem` counts a pinned upstream only when the run uses pins. External runs ignore pins by default, so B no longer runs with an empty upstream.
- The schema, credential and preflight checks (`gate`, the dry run) look only at the steps that will run: the `only` step, or the "from" set plus "Al terminar".
- `afs --dry-run` exits 1 and prints why when the dry run is not ok.

**Raw webhook payloads**
- `scope`, `from` and `mode` are options only next to a step. Without a step, a raw payload keeps those keys, and `?scope=from` in the URL is still an option.

**Integration assistant and generated snippets**
- The assistant's lint resolves steps with `findStep` and knows the `/steps/:s/run` endpoint, so step-scoped templates are no longer flagged as errors.
- CLI, MCP and INVOKE.md address the flow by id. A name can repeat, and in PS 5.1 a native-exe argument cannot carry `"` safely.
- Markdown in names is neutralised in INVOKE.md.
- Poll loops stop after 30 min with a non-zero exit.
- The contract's output is the format of the final steps of a "from" run.

**INVOKE.md regeneration**
- It is rebuilt when the definition changes (rev or name), at boot, and when the public URL changes. It is not rebuilt on every `lastRun` update.

**Accepted**
- Opening the Invoke tab on an old flow assigns its slugs, which is one save.
- A `paused` status is final for the snippets. External runs pause only when the caller passes `breakpoints: true`, and declared actions never pause a run.

Tests: `30-step-invoke` now has 8 tests.

### Second adversarial pass

The six first-pass findings were re-verified as closed. Fixed in this pass:
- **Resolution order.** `findStep` resolves in this order: id, then stored slug, then exact name, then case-insensitive name. A stored slug is the step's stable address and always wins, so renaming or adding *other* steps never breaks a pasted call. Exact names come before case-insensitive ones, so a caller that sends the name "Deploy" gets the step named Deploy.
- **Steps that come back keep their slug.** Every slug change now goes through `settleSlugs`, both in the flow save and in a restore. A step that comes back keeps the slug it brings, if that slug is valid and free. This covers undoing a delete and restoring a version after a delete.
- **Crafted step ids.** A new step whose id equals a slug in use is refused with `STEP_ID_TAKEN`.
- **Scope keys in the body.** They count as options only with our values: `scope`/`mode` set to `only|from`, or `from: true`. Any other value, such as `scope:"repository"` or `from:"alice@…"`, is data of a raw payload and stays in the input, also on the step URL that the Webhook snippet uses. `?scope=` in the query is always an option and is validated (`BAD_SCOPE`), case-insensitively.
- **Ids in INVOKE.md.** Step ids are neutralised in INVOKE.md too.

### Third adversarial pass

- **Version restore and ids.** A version restore is refused with `STEP_ID_TAKEN` (409) when a step would come back with an id that is now another live step's slug. Otherwise the restore would silently move that address to the restored step.
- **Where the slug wins.** The slug wins only on the step URL, `…/steps/:step/run`, which is the one the pasted URL snippets use. In a `step` field (body, CLI, MCP), a ref that is one step's slug and another step's name, compared case-insensitively, returns `STEP_AMBIGUOUS`. The afs and MCP snippets and the generated clients send the step id, which is stable and never ambiguous.
- **Typos in an options body.** A body with `input` is an options body, so a mistyped `scope`/`from` there is `BAD_SCOPE` and never a silent "only". `from: 1` is accepted.

### Fourth adversarial pass (closed)

The pass found one medium issue and nothing higher. In an options body, `mode: only|from` (any case) now counts as the scope next to `input` too. An unknown `mode` is `BAD_SCOPE`. The generated clients' own modes (`wait`, `async-poll`, `fire-and-forget`) are not a scope.

Spec 12 v1 is closed after one architect review and four adversarial passes. Every finding has a regression test (`30-step-invoke`: 10 tests).
