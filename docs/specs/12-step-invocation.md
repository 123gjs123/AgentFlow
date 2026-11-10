# 12 — Per-step external invocation

**Status:** Proposed. Running a single step via `step=` already works (spec 06).

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
