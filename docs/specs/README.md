# Agent Flow Studio — Specifications

Agent Flow Studio is a local web app for designing, running and talking to **flows of AI agents**. Each flow is a graph of *steps*. A step is a role, a Claude Code agent, a skill or a shell command. Everything runs through the user's own **Claude Code CLI**, so it uses their Anthropic subscription, skills, agents and MCP connectors (Jira, Confluence, Drive, etc.). No API key is involved.

This folder holds the product and technical specs. Each spec stands on its own and uses the same layout: *Summary → Goals / Non-goals → Requirements → Design → Acceptance criteria → Open questions*.

## Index

| # | Spec | Status |
|---|------|--------|
| 01 | [Architecture](01-architecture.md) | Implemented |
| 02 | [Flows, steps and execution](02-flows-steps-execution.md) | Implemented |
| 03 | [Hooks and triggers](03-hooks-and-triggers.md) | Implemented |
| 04 | [Chats: step chat, general chat and router](04-chats.md) | Implemented |
| 05 | [Memory](05-memory.md) | Implemented |
| 06 | [External invocation (API, CLI, MCP, webhook)](06-external-invocation.md) | Implemented (amended by 16: per-run vars, cancel/events, exit codes) |
| 07 | [Onboarding, help and simplified configuration](07-onboarding-help.md) | Implemented |
| 08 | [Security model](08-security.md) | Implemented |
| 09 | [Flow workspaces, export and import](09-flow-workspaces-export-import.md) | Proposed |
| 10 | [Source status checks ("pull for news")](10-source-status-checks.md) | Proposed |
| 11 | [Flow isolation](11-flow-isolation.md) | Proposed |
| 12 | [Per-step external invocation](12-step-invocation.md) | Proposed |
| 13 | [Skill sources: URL, folder, zip](13-skill-sources.md) | Proposed |
| 14 | [Step outputs: handoff, actions, deliverables](14-step-outputs-and-actions.md) | Partial (handoff and detected actions via spec 15) |
| 15 | [Data passing between steps](15-data-passing.md) | Implemented ("for each" proposed; amended by 16: pins and stale refs) |
| 16 | [Run reliability, observability and step verification](16-run-reliability-and-verification.md) | Implemented (round 1, 2026-11-10; exceptions listed in the spec) |
| 17 | [Step context box and integration helper](17-step-context-and-integration-helper.md) | Implemented with exceptions (2026-11-11; round-3 fixes applied, see the spec) |

**Status meanings**
- **Implemented:** in `main` and verified end to end.
- **Proposed:** agreed requirement, with the design described here, not built yet.
- **Partial:** some requirements built. Each requirement is marked.

## Product principles

1. **Your subscription, your tools.** The app never calls the Anthropic API directly. It drives the local `claude` CLI, so whatever the user has in Claude Code is available to every step: login, skills, agents, MCP servers and settings.
2. **Show the work.** Every model call streams its internal process to the UI: session start, reasoning, tool calls and results, tokens, denied permissions.
3. **Context is scoped.** A step's chat and memory stay within that step. Other steps' knowledge is offered only as labelled reference. Flows don't see each other unless explicitly invoked (spec 11).
4. **Few questions, good defaults.** Templates, access presets and AI flow generation make a useful flow possible without touching advanced settings.
5. **Local first and safe by default.** The app binds to `127.0.0.1`. The UI API is same-origin only, and outside callers need a token.

## Glossary

| Term | Meaning |
|---|---|
| **Flow** | A named graph of steps and edges, with variables, memory, schedule, chats and run history. |
| **Step** | One box on the canvas. Its *kind* is `role`, `agent`, `skill` or `command`; `flow` (sub-flow) is proposed in spec 11. |
| **Edge** | A manual relation "A → B": B runs after A and receives A's output. |
| **Level** | A topological layer. Steps in the same level can run in parallel. |
| **Run** | One execution of a flow, or of a single step, with per-step events and outputs. |
| **Hook** | JavaScript `onStart` / `onSuccess` / `onFailure` attached to a step. |
| **Step chat** | Persistent conversation scoped to one step (Claude session resumed with `--resume`). |
| **General chat** | Flow-level chat; a router decides which step answers or what to run. |
| **Memory** | Durable facts per step and per flow, injected into prompts. |
| **Access preset** | A named bundle of allowed tools and permission mode (e.g. "Read Jira / Confluence"). |
| **Source** | Something a step watches for changes: Jira, Confluence, git branch, URL, file, command (spec 10). |
| **Handoff** | What a step passes to the next steps: text, validated JSON, files and actions (spec 15). |
| **Pinned output** | A frozen step result reused by flow runs instead of executing the step (spec 15). |
| **Action** | A declared change in an external system (e.g. create a Jira sub-task or bug), with approval and idempotency. |
| **Deliverable** | A file a step produces in a given format (md, feature, xlsx, docx…), with destinations. |
| **External API** | Token-protected `/api/ext/*` endpoints used by the CLI, the MCP server, CI and webhooks. |

## Repository map

```
server/   index.js (HTTP + WS), engine.js (runs, chats, router), claude.js (CLI driver),
          prompt.js (prompt building), store.js (persistence), catalog.js (skills/agents)
client/   React + @xyflow/react UI (App, Canvas, Panels, Chat, Events, Help, presets)
bin/      afs.js (CLI), mcp.js (MCP stdio server), client.js (shared HTTP client)
data/     local state (flows, chats, runs, config.json with the API token); git-ignored
docs/     these specs
```
