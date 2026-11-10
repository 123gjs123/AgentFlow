# 15 — Data passing between steps

**Status:** Implemented (DATA-1 … DATA-9). DATA-10 ("for each") is proposed.

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
| DATA-4 | **References.** Templates in task, context and command accept `{{steps.<name>.output}}`, `{{steps.<name>.json}}`, `{{steps.<name>.json.a.b.0.c}}`, the shorthand `{{steps.<name>.a.b}}`, `{{steps.<name>.files}}` and `{{steps.<name>.actions}}`. Names may contain spaces and accents. `{{vars.a.b}}` supports nested paths. Values come from the current run, then the pinned output, then the last output. |
| DATA-5 | **Insert-data picker.** A "{ } Insertar dato" button next to task, context and command lists: the flow input, variables, every *earlier* step (transitively, closest first) with its JSON fields and sample values from its last or pinned output, and the other steps, flagged as "not earlier: last output". The reference is inserted at the cursor, or at the end if the field was never focused. |
| DATA-6 | **Input mode** (AI steps): `step.input.mode` = `full` (text + JSON, default), `json` (only JSON blocks, falling back to text), `summary` (each upstream output over 1,500 chars is summarised by Haiku once per run, keeping ids, keys, numbers and decisions), or `refs` (no automatic upstream section; only what the task references). `step.input.maxChars` caps each upstream (default 12,000). |
| DATA-7 | **Command steps** receive upstream text on stdin and in `STEP_UPSTREAM`, upstream JSON as `{stepName: json}` in `STEP_UPSTREAM_JSON`, and the flow input in `FLOW_INPUT`. |
| DATA-8 | **Input/Output view** (step → "Datos" tab). *Input:* each upstream step with its size, JSON flag and summarised flag, the exact prompt sent (copyable), the step's system instructions, or, for commands, the rendered command and stdin. *Output:* JSON, text, files written, and actions performed. |
| DATA-9 | **Pin data.** Pin the last output, or write test data by hand (text and/or JSON). During a flow run a pinned step **is not executed**: the activity log says so, and downstream steps receive the pinned data. An explicit single-step run still executes the step and keeps the pin. Pins are server-managed (UI saves can't overwrite them), shown with 📌 on the node and the tab, and removed with "Desfijar". |
| DATA-10 | *(Proposed)* **For each.** Run a step once per element of an upstream JSON array (e.g. per ticket), with limited parallelism, and collect the results into an array. |

**Detected side effects.** During AI runs, files written with `Write` / `Edit` are listed as `files`. MCP calls whose tool name starts with create / add / edit / update / transition / delete / send / share / trash / copy / move / upload / post are listed as `actions` `{tool, server, ok, input, result}`. Nodes show ⚡ N. This is the "skill-managed actions" part of spec 14 (3.4).

## Data model additions (step)

```jsonc
"output": { "format": "text | json", "schema": "<JSON Schema as text>" },
"input":  { "mode": "full | json | summary | refs", "maxChars": 12000 },
"pinned": { "output": "...", "json": {}, "at": 0, "source": "last | edited", "runId": "r_…" },   // server-managed
"lastRun": { …, "json": {}, "files": [], "actions": [], "pinned": false }
// run.steps[id]: + json, files, actions, pinned, inputView { kind: ai|command, mode, prompt, system, command, stdin, upstream[] }
```

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
3. With A pinned to hand-written data, a flow run does not execute A (its only event is the pin notice), and B prints the pinned values.
4. Running pinned A on its own executes it, and unpinning removes the 📌.
5. A Haiku step in `json` input mode with an output schema returns valid JSON on the first try. Its prompt contains the resolved reference and the upstream JSON block.
6. The picker lists `json.summary`, `json.cases.0.t`… with sample values, and inserts at the end when the field wasn't focused.
