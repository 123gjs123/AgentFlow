# 15 — Data passing between steps

**Status:** Implemented (DATA-1 … DATA-10; DATA-10 "for each" on 2026-11-18, e2e `test/e2e/27-for-each.test.mjs`). Amended by spec 16 (2026-11-10): DATA-4 and DATA-9 below.

## Summary

Steps used to hand each other plain text only, and an AI step received every upstream output in full. This spec borrows the parts of n8n's data model that fit a flow of AI agents and leaves out the rest. Each step now produces a **structured result**. Other steps can **reference any field** of it, choose **how much context** they receive, see exactly **what went in and out**, and **pin** a result to test downstream steps without re-running (and paying for) upstream steps.

## Borrowed from n8n vs. not

| Borrowed | Not borrowed (and why) |
|---|---|
| JSON output per node, fields referenced by path | "Everything is a list of items" plus paired-item tracking: too complex, and agents don't need it |
| Referencing any earlier node, not just the parent | A full JS expression language in every field: simple templates plus hooks are enough |
| Input/Output inspector per node | Merge node and its modes: a step with several parents already receives all of them |
| Pin data | — |
| Binary data separate from JSON (as file paths) | — |

What we **added** that n8n doesn't need: choosing how much upstream context goes into a prompt. Our steps pay per token, and too much context also lowers answer quality.

## Requirements

| ID | Requirement |
|---|---|
| DATA-1 | **Structured result.** Each step run produces `{output (text), json?, files[], actions[]}`. It is stored in the run and in `step.lastRun`, and returned by the external API (`steps[].json/files/actions`, plus top-level `json` when the flow has a single final step). |
| DATA-2 | **JSON output.** `step.output.format = 'json'`. AI steps are told to end their answer with a single fenced `json` block. The app extracts it, and the rest of the answer stays as `output`. Command steps parse stdout as JSON. |
| DATA-3 | **Schema.** `step.output.schema` is an optional JSON Schema (type, required, properties, items, enum, minItems). If the JSON is missing or invalid, an AI step gets **one automatic correction turn** in the same session. If it still fails, the step errors with the validation messages. The UI can generate a schema from a pasted example. |
| DATA-4 | **References.** Templates in task, context and command accept `{{steps.<name>.output}}`, `{{steps.<name>.json}}`, `{{steps.<name>.json.a.b.0.c}}`, the shorthand `{{steps.<name>.a.b}}`, `{{steps.<name>.files}}` and `{{steps.<name>.actions}}`. Names may contain spaces and accents. `{{vars.a.b}}` supports nested paths. Values come from the current run, then the pinned output, then the last output. **Spec 16 OBS-1/OBS-2:** each resolved reference is recorded in the step's `inputs[]` with `source: run | pinned | lastRun` and `fromRunId`; in a full run, a reference to a step that is not a transitive ancestor fails the step with `NON_UPSTREAM_REF` unless `step.input.allowNonUpstream = true`. Single-step runs are allowed. |
| DATA-5 | **Insert-data picker.** A "{ } Insertar dato" button next to task, context and command lists: the flow input, variables, every *earlier* step (transitively, closest first) with its JSON fields and sample values from its last or pinned output, and the other steps, flagged as "not earlier: last output". The reference is inserted at the cursor, or at the end if the field was never focused. |
| DATA-6 | **Input mode** (AI steps): `step.input.mode` = `full` (text + JSON, default), `json` (only JSON blocks, falling back to text), `summary` (each upstream output over 1,500 chars is summarised by Haiku once per run, keeping ids, keys, numbers and decisions), or `refs` (no automatic upstream section; only what the task references). `step.input.maxChars` caps each upstream (default 12,000). |
| DATA-7 | **Command steps** receive upstream text on stdin and in `STEP_UPSTREAM`, upstream JSON as `{stepName: json}` in `STEP_UPSTREAM_JSON`, and the flow input in `FLOW_INPUT`. |
| DATA-8 | **Input/Output view** (step → "Datos" tab). *Input:* each upstream step with its size, JSON flag and summarised flag, the exact prompt sent (copyable), the step's system instructions, or, for commands, the rendered command and stdin. *Output:* JSON, text, files written, and actions performed. |
| DATA-9 | **Pin data.** Pin the last output, or write test data by hand (text and/or JSON). During a flow run a pinned step **is not executed**: the activity log says so, and downstream steps receive the pinned data. An explicit single-step run still executes the step and keeps the pin. Pins are server-managed (UI saves can't overwrite them), shown with 📌 on the node and the tab, and removed with "Desfijar". **Spec 16 EXT-10:** external runs (API, CLI, MCP, webhook) ignore pins unless the request sets `usePins: true` (CLI `--pins`); the summary lists `usedPins`. UI runs still use pins. |
| DATA-10 | **For each.** Run a step once per element of an upstream JSON array (e.g. per ticket), with limited parallelism, and collect the results into an array. See "For each (DATA-10)" below. |

**Detected side effects.** During AI runs, files written with `Write` / `Edit` are listed as `files`. MCP calls whose tool name starts with create / add / edit / update / transition / delete / send / share / trash / copy / move / upload / post are listed as `actions` `{tool, server, ok, input, result}`. Nodes show ⚡ N. This is the "skill-managed actions" part of spec 14 (3.4).

## Data model additions (step)

```jsonc
"output": { "format": "text | json", "schema": "<JSON Schema as text>" },
"input":  { "mode": "full | json | summary | refs", "maxChars": 12000 },
"pinned": { "output": "...", "json": {}, "at": 0, "source": "last | edited", "runId": "r_…" },   // server-managed
"lastRun": { …, "json": {}, "files": [], "actions": [], "pinned": false }
// run.steps[id]: + json, files, actions, pinned, inputView { kind: ai|command, mode, prompt, system, command, stdin, upstream[] }
```

## For each (DATA-10)

`step.forEach = { path, from?, parallel, max }`. It is saved sanitised, and unticking "🔁 Para cada" removes it.

| Field | Meaning |
|---|---|
| `path` | Where the list is in the JSON (`automatizacion`, `data.items`). `""` means the JSON itself. |
| `from` | The step whose output holds the list: an id or a name, in this run, or else its last output. Without it, the first incoming arrow whose JSON has an array at `path`. |
| `parallel` | How many elements run at once, 1 to 4. The default is 1, one at a time, because the environments are shared. |
| `max` | At most this many elements per run, 1 to 50, default 20. The rest are dropped with a warning. |

**What each element gets**
- An extra input "Elemento i de N" with the element, as text and as JSON.
- Templates `{{item}}`, `{{item.<path>}}`, `{{item.index}}` and `{{item.total}}`. In commands they travel as environment variables, like every template value.
- Command steps also get `AFS_ITEM` (the text, or the JSON for an object), `AFS_ITEM_INDEX` and `AFS_ITEM_TOTAL`.

**The run**
- Each element is a nested run of the same step, `run.steps["<id>~<i>"]`, with its own events, usage and limits.
- The step's own record carries `forEach {total, from, parallel, items[{i, label, key, status}]}`. Its activity logs one line per element (▶ / ✓ / ✗).
- The label of an element is its `key`, `ticket`, `id`, `name`, `nombre` or `title`, or else the start of its JSON.

**The result**
- `output`: one section per element ("## SBK-1 — success").
- `json`: `[{item, status, json?, output, error?}]`, which is what the following steps receive.
- Files, actions and routes are joined, and usage is added up.

**Errors and the empty case**
- If an element fails, the others still run. The step ends in `error` with code `FOR_EACH_FAILED` ("Fallaron 1 de 3: B").
- A source that is not a list fails with `FOR_EACH_SOURCE` and says what it found.
- An empty list skips the step with `skipReason: 'empty'`, which is not a failure, and the steps after it do not run (`not_routed`).

**Exceptions**
- A pinned step returns its pin; it does not iterate.
- A "break after" pauses once, on the combined result. "Retry" runs every element again.

**UI:** a "🔁 Para cada elemento de una lista" box in the step's config (list, "de la salida de" with the step's ancestors, how many at once, maximum), and 🔁 on the node.

## API

| Method & path | Purpose |
|---|---|
| `POST /api/flows/:id/steps/:stepId/pin` `{fromLast:true}` or `{output, json}` | Pin the last output, or pin hand-written data |
| `DELETE /api/flows/:id/steps/:stepId/pin` | Unpin |
| `GET /api/flows/:id/runs/:runId` | Includes `inputView`, `json`, `files` and `actions` per step |

**Hooks:** `ctx.upstream['Step name'] → {output, json}` and `ctx.json`. `onSuccess` may return `{output, json}`.

## Acceptance criteria (verified)
1. Command A outputs JSON with a schema. Command B uses `{{steps.Leer ticket.json.summary}}` and `{{steps.Leer ticket.cases.0.t}}`, and gets the right values plus `STEP_UPSTREAM_JSON`.
2. A schema requiring a missing field makes A fail with `$.nope: requerido`, and B is skipped.
3. With A pinned to hand-written data, a UI flow run (or an external run with `usePins: true`) does not execute A (its only event is the pin notice), and B prints the pinned values.
4. Running pinned A on its own executes it, and unpinning removes the 📌.
5. A Haiku step in `json` input mode with an output schema returns valid JSON on the first try. Its prompt contains the resolved reference and the upstream JSON block.
6. The picker lists `json.summary`, `json.cases.0.t`… with sample values, and inserts at the end when the field wasn't focused.
