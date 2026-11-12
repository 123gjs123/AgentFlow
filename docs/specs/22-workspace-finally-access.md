# 22 · Flows that build things: working directory, "Al terminar", run ids, restricted terminal

Status: Implemented (2026-11-12). Verified by `test/e2e/15-workspace-finally-access.test.mjs`.

## Origin

An architect and an adversarial reviewer looked at a real flow: a Docker image, tests to raise API coverage to 95%, and a report. Their findings were:
- with an empty working directory, everything happened in the user's home;
- data never reached later steps;
- coverage was self-reported by the model;
- "inside the container" was only an instruction;
- nothing guaranteed cleanup or the right git identity.

The user's constraint: **the app must be ready for this, but most flows are simpler (no image, no code at all) and others are more complex (Docker, Argo inside an image).** Everything below is generic and opt-in. A flow that does not use it behaves exactly as before.

## Decisions

| # | Decision | Why |
|---|---|---|
| B1 | **Safe working directory.** A configured `cwd` that does not exist stops the run before it starts (`CWD_MISSING`, 422), from the UI, the API, the dry run and the preview. It never silently falls back to home. With no `cwd`, steps that can write or run commands warn that they will work in the user's home. Read-only or reasoning-only steps show nothing. The Flujo tab has a folder browser. | Writes, clones and builds landing in `C:\Users\<user>` by accident. |
| B2 | **"Al terminar (siempre)"** (`flow.finally {command, shell, timeoutSec}`). It is a command that runs after every **full** run: success, error, stop, timeout, and also for runs marked `interrupted` after a server restart. It receives `AFS_RUN_ID`, `AFS_RUN_STATUS`, `AFS_RUN_STEPS_JSON`, `FLOW_INPUT` and `AFS_FLOW`, plus templates (`{{vars}}`, `{{run.id}}`, `{{steps.X.json…}}`). The result goes in `run.finally` and does not change the run status. The run stays "running" until it ends. Raw templates with external data are rejected (422). | "No garbage" must hold even when something fails or is cancelled. Cleanup is deterministic, so it is a command, not an AI step. |
| B3 | **`{{run.id}}`, `{{run.short}}`, `{{run.date}}`** in tasks, commands, context references and "Al terminar". | Names unique per run: branches, compose projects, labels, artifact folders. |
| B4 | **New access presets.** "Editar + terminal restringida (git sin push, docker)": built-in Bash enabled, but only `git status/diff/log/show/add/commit/switch/checkout/fetch/branch/rev-parse` and `docker` / `docker compose` are pre-approved. Anything else is denied (headless) and the step fails with `PERMISSION_DENIED`. No web. "Solo lectura local (sin web)" is the other new one. Other toolchains (kubectl, argo, helm) use "Personalizado" with the same `Bash(cmd:*)` patterns. The AI flow generator knows these presets and prefers command steps for deterministic work. | A guard-rail, not a sandbox: a model with docker is root-equivalent on the host. A per-step container sandbox (running the Claude CLI inside an image) stays deferred until the guard-rail proves insufficient. |

## Pattern for complex flows (example: "Cobertura API Synergy 95% v2")

1. **Preparar workspace** (command): its own clone and a branch per run, the local git identity, `docker info`, and JSON `{repo_path, work_branch, base_commit, inputs_hash, artifacts}`.
2. **Imagen Docker** (AI, restricted terminal, `breakpoint: after`): Dockerfile and compose, a deterministic coverage script, and a JSON contract `{image, compose_file, service, test_cmd, coverage_cmd}`. A command assertion checks that the image exists.
3. AI steps read the contract with `{{steps.Imagen Docker.json.*}}` and run things only through `docker compose run --rm`.
4. **Cobertura medida** (command): an independent measurement, so the report never relies on what the model says.
5. Git assertions: commits only with the work identity, and no push.
6. **Al terminar**: `docker compose -p afs-{{run.short}} down -v --remove-orphans`.

Simple flows use none of this: no working directory, no "Al terminar", read-only access.
