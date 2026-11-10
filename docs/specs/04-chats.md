# 04 — Chats: step chat, general chat and router

**Status:** Implemented

## Summary

Every step has its own **chat**, scoped to that step's role, skill or agent, task and last run. Each flow also has a **general chat** where the user writes naturally. A lightweight router decides which step should answer, or whether something should run. From a step chat the user can **improve** the step (role, task, context, tools, hooks) or, in *improve mode*, the underlying skill or agent files.

## Requirements

| ID | Requirement |
|---|---|
| CHAT-1 | Each step chat is a persistent Claude session (`--resume`), separate for every step. |
| CHAT-2 | Each turn carries a `<step-context>` block: config, neighbours, last run output and error, memory, variables. The block is sent in full only when its hash changed since the session last saw it. |
| CHAT-3 | Answers stay within the step's scope. Other steps' memory is supplied as `<related-memory>`, marked as reference. |
| CHAT-4 | The assistant can propose configuration changes with `<step-update>{json}</step-update>`. The UI shows a diff card, and the change is applied only when the user clicks **Apply**. |
| CHAT-5 | The assistant can store facts with `<remember>…</remember>` (spec 05). Explicit "remember this" requests always produce a tag. |
| CHAT-6 | **Improve mode** (skill and agent steps): grants `Edit Write` plus `--add-dir <skill/agent folder>` with `acceptEdits`, so Claude can edit the skill or agent definition directly. |
| CHAT-7 | General chat: a router (Haiku, no tools, no session persistence, ~700 tokens) returns `{action, target, reason, message, input}`. |
| CHAT-8 | Router actions: `ask` a step, `ask` the flow, `run_step`, `run_flow`. Runs happen only when the user explicitly asks to run something. |
| CHAT-9 | A routed answer is produced **through the target step's own session**, so it also appears in that step's chat history. It is mirrored live into the general chat, which shows who answered and why. |
| CHAT-10 | Every answer shows its internal process: reasoning, tools, results and tokens (spec 01 events). |
| CHAT-11 | A chat can be stopped mid-answer and reset. Reset clears its history and session. |
| CHAT-12 | If a resumed session is gone, the turn retries once in a fresh session with the full context. |

## Chat keys and storage

| Key | Chat |
|---|---|
| `<stepId>` | Step chat |
| `_flow` | Flow-level assistant (used when the router targets "flow") |
| `_global` | General chat transcript (user messages, router decisions, mirrored answers) |

Messages: `{id, role: user|assistant|router, text, at, origin, status, events[], proposals[{id, patch, applied}], remembered[], routedTo?, routedKey?, originMessageId?}`.

## Proposal patch fields

Allowed fields: `role, task, context, allowedTools, model, effort, permissionMode, hooks, name, command, shell`. Invalid JSON is shown as invalid and cannot be applied.

## Prompts

- **Step chat system prompt:** static, so the resumed session stays coherent. It defines the scope, the tag formats, the improve-mode rule and "answer in the user's language".
- **Flow chat system prompt:** answers about the flow as a whole and receives a `<flow-context>` listing every step.
- **Router:** gets the step catalog (id, name, kind, ref, clipped role/task, last 5 memory items), the last 6 messages and the new message. It returns JSON only, parsed loosely. If the target is invalid, the flow chat answers.

## Acceptance criteria
- Asking a step chat "why did you flag risk X?" answers using the step's last output.
- Asking it to "make the task stricter about negative cases" produces a proposal card. Applying it updates the step's task.
- In the general chat, a question about test design is routed to the test-design step, with a visible reason. It also shows up in that step's own chat.
- "Run the flow with SBK-123" starts a run with trigger `chat` and input `SBK-123`.
