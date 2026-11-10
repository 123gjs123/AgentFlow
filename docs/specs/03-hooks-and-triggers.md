# 03 — Hooks and triggers

**Status:** Implemented

## Summary

Steps can carry **code-defined actions** (hooks) that run before and after the step. Flows can be **triggered** manually, from chat, on a schedule or from outside. Hooks make it possible to call Jira, Confluence or Bitbucket (via MCP or git), run shell commands, chain other steps, and change inputs and outputs.

## Requirements

| ID | Requirement |
|---|---|
| HOOK-1 | Each step has an optional JavaScript source that defines `onStart`, `onSuccess` and/or `onFailure`. |
| HOOK-2 | `onStart` may return `{skip: true, output?}` to skip the step, or `{input: '...'}` to replace the input. |
| HOOK-3 | `onSuccess` may return a string to replace the step output. |
| HOOK-4 | `onFailure` receives `ctx.error`. |
| HOOK-5 | Hooks have a context API (below). Every call they make is logged in the step's activity. |
| HOOK-6 | The UI offers a starter template and snippets: Jira comment, Confluence page, Bitbucket/git, shell, chain step. |
| TRIG-1 | Triggers: manual (UI), chat (router decides `run_flow` / `run_step`), schedule (every N minutes), external (spec 06). |
| TRIG-2 | Every run records its trigger (`manual`, `chat`, `schedule`, `api`, `webhook`, `cli`, `mcp`…). |

## Hook context API

| Member | Description |
|---|---|
| `ctx.input`, `ctx.output`, `ctx.error` | Current values |
| `ctx.vars`, `ctx.flow`, `ctx.step`, `ctx.runId` | Read-only info |
| `ctx.sh(cmd, {shell})` | Runs a command in the flow cwd. Returns `{code, stdout, stderr}`. |
| `ctx.ai(prompt, {tools, model, permissionMode})` | One-off Claude call with the given tools (e.g. Atlassian MCP tools). Returns text. |
| `ctx.runStep(nameOrId, input)` | Runs another step **of the same flow** and returns its output. |
| `ctx.remember(text)` | Adds a fact to this step's memory. |
| `ctx.setVar(k, v)` | Persists a flow variable. |
| `ctx.log(...args)` | Writes to the activity log. |

### Example

```js
async function onSuccess(ctx) {
  await ctx.ai(`Add a comment to ${ctx.vars.issue} summarising:\n\n${ctx.output}`,
    { tools: 'mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue mcp__claude_ai_Atlassian_Rovo__getAccessibleAtlassianResources' });
}
```

## Design notes
- Hooks are compiled with `new Function` and run **in the server process** with the user's privileges. This is acceptable because the app is local and single-user; spec 08 has the threat model. Hooks are never accepted from outside callers: the external API cannot edit flows.
- If a hook fails to compile, the error is logged and the step still runs without hooks.
- A hook that throws marks the step as `error`.

## Acceptance criteria
- `onStart` returning `{skip:true}` marks the step `skipped`, and downstream steps receive its `output`.
- `ctx.sh('git log -1 --oneline')` shows a `hook.sh` tool call and its result in the activity log.
- A scheduled flow with `everyMinutes: 1` produces runs with trigger `schedule`. It does not overlap with a run that is still in progress.
