# 23 · Flow requirements and preflight check

Status: Implemented (2026-11-12). Verified by `test/e2e/16-requirements-preflight.test.mjs`.

## Request (user, 2026-11-12)

> "Para estos flujos complejos, ¿cómo se le advierte a la persona lo que debe tener instalado (ej. Docker) o el archivo de secretos? Ahora me entero hablando con vos, pero si la idea es que este producto esté para otras personas…"

## Decisions

| # | Decision | Why |
|---|---|---|
| P1 | A flow declares **requirements** in `flow.requirements[]`. They are part of the definition, so they travel with the flow, get versioned and merge between tabs. There are five types (see "Requirement types" below). Each has a visible label, a **help** text explaining how to get it (a default exists for known tools: Docker, git, Python, Node, Java, Maven, Gradle, .NET, kubectl, Helm, Argo, az, aws, gh, PowerShell), and can be **only recommended** (`optional`). | Whoever runs the flow, not only its author, must learn what is needed and how to get it. |
| P2 | **Preflight before every run** (UI, a single step, the external API, `afs`, MCP). If a required item is missing the run does not start: **412 `PREFLIGHT_FAILED`** with `missing[]` (what, why and how to fix). Recommended items never block. The dry run returns `preflight {ok, missing, results}`. Results are cached for 30 s, and the cache is cleared when the flow is saved. Flows without requirements behave as before. | Fail before spending time or money, with instructions instead of a stack trace. |
| P3 | In the UI: a **"✅ Requisitos para usar este flujo"** editor in Flujo, with live ✓/✗, plus a header chip **"⚠ Faltan N requisitos"** and an **"Antes de ejecutar este flujo"** window. That window opens when a run is blocked, explains each item, lets you "Comprobar de nuevo" and "Crear desde plantilla", and offers "✔ Todo listo" to retry the run. | |
| P4 | **"✨ Sugerir"** proposes requirements from what the flow uses: tools named in commands, access lists and assertions (`docker`, `git`, `kubectl`, `argo`…); bash steps; Atlassian tools or Jira/Confluence context; variables that hold file paths (with a secrets template when they look like an env or credentials file) or service URLs (as recommended; clone URLs are skipped). | The author does not have to remember everything. |
| P5 | The server trusts the **operating-system certificate store** at startup (`server/certs.js`, Node ≥ 22.15). A certificate error during a URL check counts as "responds (certificate not verifiable)", not as down. | Found while checking a real flow: behind the corporate TLS proxy every HTTPS check failed with `SELF_SIGNED_CERT_IN_CHAIN`. |

## Requirement types (P1)

- **🧰 tool**: the tool is on the PATH and, optionally, a check command succeeds (for example, `docker info` to know Docker Desktop is running).
- **📄 file**: the file exists. Paths accept `{{vars.x}}`, `%VAR%`, `$env:VAR` and `~`. With a **template**:
  - "Crear desde plantilla" creates the file with the key names. It never overwrites an existing file.
  - The file keeps failing while any key in the template still has no value (for example, an empty secret).
- **🔑 env**: the environment variable is visible to the server.
- **🌐 url**: the URL answers. Any HTTP status below 500 counts, which also proves VPN or network access.
- **🔌 mcp**: the Claude Code connector is connected. This uses the CLI init probe, which makes no model call.

## API

- `GET /api/flows/:id/preflight[?fresh=1][&probe=1]`
- `GET /api/flows/:id/requirements/suggest`
- `POST /api/flows/:id/requirements/:rid/create-file`
