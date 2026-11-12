# Agent Flow Studio

A local UI for building and running AI agent flows on **your own Claude Code**. It uses your subscription and your skills, agents and MCP connectors (Atlassian Rovo, Drive…). No API key needed.

## Getting started

```
npm install      # behind the corporate proxy: NODE_OPTIONS=--use-system-ca npm install
npm start        # → http://127.0.0.1:4317   (or double-click start.cmd)
```

## Concepts

- **Step** = a box on the canvas. Each step can be one of four types:
  - 🎭 **Rol**: a persona/instructions you write yourself.
  - 🤖 **Agente**: a Claude Code agent (`~/.claude/agents`, plugins, the project). Runs with `--agent`.
  - 🧩 **Skill**: one of your skills (user, claude.ai, plugins). It is invoked through the Skill tool.
  - ⌨️ **Comando**: PowerShell, bash or cmd. Supports `{{input}}`, `{{vars.x}}` and `{{steps.Nombre.output}}`.
- **Relaciones**: you drag them by hand. The order is computed automatically, both execution order (topological levels, up to 2 steps in parallel) and layout (dagre). Cycles are not allowed.
- **Contexto**: each step receives the outputs of the steps before it, plus the flow input, the variables and its memory.
- **Hooks (código)**: `onStart` / `onSuccess` / `onFailure` per step, in JS. They have `ctx.sh`, `ctx.ai(prompt, {tools})` (for Jira or Confluence through MCP), `ctx.runStep`, `ctx.remember` and `ctx.setVar`.
- **Triggers**: manual, from the chat ("ejecuta el flujo…"), on a schedule (every N minutes), or a local webhook `POST /api/flows/:id/trigger`.

## Chats

- **Chat del step**: a persistent session (`--resume`) scoped to that step. It receives the step's current configuration, its last run, its memory and related memory from other steps.
  - It can propose changes to the role, task, context, tools or hooks (`<step-update>`). You apply them with a button.
  - It can save facts to memory (`<remember>`).
  - **Modo mejora** (skill/agent steps) lets it edit the skill or agent file directly.
- **Chat general**: write in plain language. A router (Haiku, no tools, about 700 tokens) decides which step/agent/skill/role answers, or whether to run something, and shows you why. The answer goes through the target step's session, so it also stays in that step's history.
- **Proceso interno**: every answer and run shows the session start (model, active MCPs), reasoning, each tool call with its input and result, hooks, tokens and duration. Denied permissions are flagged.

## Memory

- One memory per step and one general memory for the flow (the Memory tab).
- Entries are added automatically from runs and chats, or by hand.
- Related memory from other steps is attached by keyword relevance. It is marked as reference only, so the step stays within its own scope.

## Permissions and security

- Each step only runs the tools listed under "Tools permitidas". Everything else is denied, and the denial shows up in Activity. A prefix such as `mcp__claude_ai_Atlassian_Rovo` enables a whole MCP server.
- The server listens on `127.0.0.1` only, because hooks and commands run on your machine.

## Specs

Product and technical specs (English) live in [docs/specs/](docs/specs/README.md).

## Tests

Functional e2e suite (real servers + mock Claude CLI; no subscription use, your flows untouched). Run before every release:

```
npm run test:release   # vite build + every suite, JUnit in test-results/e2e-junit.xml
npm run test:e2e       # suites only
```

What it covers, the mock directives and how to add a test: [test/e2e/README.md](test/e2e/README.md).

## Data

All data lives in `data/` (flows, chats, runs) as JSON.
