# 28 · 🩺 Revisión del flujo (evaluador de flujos), 📜 Reglas y 🧪 Ensayo

Status: Implemented (2026-11-17). Verified by `test/e2e/23-flow-review.test.mjs` and `test/e2e/24-ui-flow-review.test.mjs`.

## Origin

The user ran a real QA flow end to end on ticket SBK-10110. Thirteen problems surfaced, and none was visible before running. Fixing them by hand took about three hours:
- a connector the CLI does not load;
- unwanted writes to Jira;
- a skill that does not exist;
- no working folder or isolation;
- denied commands (`cd &&`, `VAR=x`);
- the CLI's 10-minute Bash limit, plus a "success" with an empty output;
- a headless Chrome left alive by TestCafe;
- the wrong environment assumed;
- the change's scope decided without reading the code;
- shared environments without data;
- a `Co-Authored-By` trailer;
- a 25-minute cap that cut the regression;
- a ticket in Done that nothing stopped.

The request, in the user's words: "que la propia herramienta tenga un agente de evaluación de los flujos que se arman y le propongan mejoras discutidas con los roles de producto, el adversarial y el arquitecto… no podemos librar el flujo a los usuarios". It was then "vayamos con todo, no solo con el mvp".

How the design was reached:
1. A product owner and an architect proposed independently.
2. An adversarial reviewer showed that an LLM reading prompts would have caught 4 or 5 of the 13. The costly ones were machine, environment and behaviour problems, and the existing proposal path let an accepted change widen permissions with nothing to stop it.
3. This design is the result. The code was reviewed adversarially again before closing.

## Decisions

| # | Decision | Why |
|---|---|---|
| R1 | **Layers, cheapest first.** (1) **Lint**: deterministic rules on the definition and the policies, plus machine probes. No tokens, computed when the panel opens. (2) **Run review**: the same pass over a digest of the latest runs and rehearsals. (3) **AI review**, on demand. (4) **Rehearsal**, on demand. | Adversarial: rules, probes and behaviour catch the expensive problems; a model reading prompts mostly suggests more prompt text. |
| R2 | **Security first, for every proposal** (chat, review or lint fix). Every change goes through `engine.applyChange`. It never accepts `permissionMode` outside default, acceptEdits, plan or dontAsk, and never Bash without a pattern (400). A change that **widens access** returns 409 `WIDEN_CONFIRM` plus the list unless it carries `confirmWiden: true`; the UI asks in a separate confirmation and there is no "apply all". Widening means: new tools that are not read-only, permissions acceptEdits or dontAsk, a different command or hooks, an added command step, a machine-wide rule. This is re-checked at apply time against the current flow. | Bug found by the adversarial review: `applyStepPatch` accepted anything, including text injected from a ticket into a model's answer. |
| R3 | **Policies (📜 Reglas)** are an object distinct from memory (MEM-7 stands). Scope is `machine` (config.json `policies`, every flow) or `flow` (part of the definition: versioned, exported as `source: import`). Types: `noExternalWrites`, `defaultEnv`, `noCoAuthorTrailer`, `gitAuthor`, `ticketStatus`, `noParallelRuns`, `note`. Each type states **what it guarantees and what it does not**, in the UI and in `policies.js`. | Adversarial: "política verificable" was false security when presented as total. Honesty: "garantizado en X, no garantizado en Y". |
| R4 | **Enforcement when running** (`policies.runtimeFor`). `noExternalWrites` adds known MCP write tools (whole Atlassian servers included) and `git push` / `curl` writes to `--disallowedTools`; a command step cannot be stopped, so the lint marks it ⛔. `noCoAuthorTrailer` passes `--settings` with attribution off. `gitAuthor` sets `GIT_AUTHOR_*` and `GIT_COMMITTER_*` (AI and command steps). `defaultEnv` fills an empty variable. `noParallelRuns` returns 409 `FLOW_BUSY`. Every policy's text goes into a "Reglas del equipo" system section. | What the app can enforce, it enforces; text is the last resort. |
| R5 | **`step.bashTimeoutMin`** sets `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` for that step's CLI. `runClaude` accepts `env` and `settings`. | Fixes problem 6 at the source instead of the `--bg`/`wait` workaround. |
| R6 | **Rehearsal** (`POST /api/flows/:id/rehearsal`, trigger `rehearsal`). AI steps run in **plan mode** with write tools disallowed and a system section asking for a "Me falta" list. Commands matching `COMMAND_WRITE_RE` (push, POST/PUT/PATCH/DELETE, commits, deletes, containers, `bb.mjs open-pr`…) are **skipped**, and downstream gets their last real output. Each step is capped (`AFS_REHEARSAL_STEP_SEC`, default 180 s). Breaks are off, "Al terminar" does not run, the steps' `lastRun` is never touched, and the attention list ignores rehearsals. Denials are information, not failure. | Finds before going live what today only a real run shows: denials, missing tools, time, what each step would do. |
| R7 | **Lint rules** (`review.lintFlow`). Each finding carries severity (⛔ va a fallar, ⚠ riesgo, 💡 mejora), **literal evidence**, a stable fingerprint (rule + step + subject, never the model's words), an anchor (the step's definition hash, or the flow's vars and policies) and, when possible, a fix: `flow`, `structure`, `policy` or the `action` cleanup-headless.<br><br>**Definition rules:** R-REF, R-MCP (against the CLI's real init), R-CWD, R-WRITE-EXT, R-SECRET (quoted masked), R-CRED, R-LONG-BASH, and the policy rules POL-DEFAULT-ENV, POL-PARALLEL-SCHEDULE, POL-TICKET-GATE.<br><br>**Run rules:** R-DENY (shell form vs. a read command to allow; widening), R-FALSE-SUCCESS (Bash left in the background, short "espero…" output), R-BASH-TIMEOUT, R-FLAKY, R-SLOW, R-MCP from runs, R-REHEARSAL-SKIP, R-REHEARSAL-MISSING.<br><br>**Machine rule:** P-HEADLESS (TestCafe, Puppeteer and Playwright Chromes left alive; "Cerrar" never touches the person's own Chrome). | Covers 1, 2 (partially), 3, 4 (cwd), 5, 6, 7, 11 (by policy), 12 and 13 (gate) of the 13. |
| R8 | **Run evidence is versioned.** Every run stores `stepHashes`, and the review ignores evidence from versions of a step that no longer exist. Old runs without hashes do not repeat a denial whose fix is already applied. | Otherwise an applied fix would keep its finding forever. |
| R9 | **AI review = 2 INDEPENDENT calls, in series, plus a merge in code.** The two calls are constructive (product + architect) and adversarial (blind red team, same dossier, never the other answer). They run in series so they do not take every Claude slot from a scheduled run. Each call is read-only (`--tools Read,Grep,Glob`, write tools disallowed, `--strict-mcp-config`, no persistence) and returns JSON with evidence. The code checks each quote against the definition or the cited run (`verifyEvidence`); an unverifiable claim never blocks (severity → 💡, "sin evidencia verificable"). It deduplicates by category + step and keeps the **dissent** visible. The recommended fix is the verifiable or structural one (structure > policy > config > text), not the most convincing voice. There is no Opus moderator. | Adversarial: 3 voices in one call is theatre; 3 calls plus a moderator cost about 4x for nothing new. |
| R10 | **Dossier** (`buildDossier`): definition, edges, policies, lint, machine state, dismissed findings and digests (not whole runs). Run data goes inside `<untrusted-data>`. Maximum 40k characters, trimmed by priority, secrets masked. | Injection from ticket text, cost, and secrets. |
| R11 | **The review never runs while the flow runs** (409 `FLOW_RUNNING`, 423 in quarantine, 409 `REVIEW_RUNNING`). A run that starts during a review cancels it (reason saved), because runs have priority. | Product rule (spec 25, C9). |
| R12 | **The conversation** happens in the `_review` chat: spec 25 mechanics, read-only tools and its own system prompt with the three voices. The person can address one with "@producto", "@arquitecto" or "@adversarial". New tags: `<policy-update>` and `<structure-update>` (a step inserted after another, edges rewired). AI findings with a fix become proposals of that chat. A proposal born in the review is anchored to the steps it touches: if they change, applying it returns 409 `REVIEW_STALE`. | The person decides; "nunca aprobado": the review says what it could not verify. |
| R13 | **Dismiss** with a reason (no aplica, es intencional, riesgo aceptado, lo hago después), per fingerprint + anchor. A dismissed finding comes back when its step changes. Everything dismissed is listed and can be shown again. | No nagging, no silently forgotten risks. |
| R14 | **🔔 (spec 27): kind `review`.** It shows blocking lint findings, or a finished AI review with open proposals. Target `open: 'flowreview'` (navigation only). The lint for 🔔 runs in the background: one computation in flight per flow, at most every 30 s while edits keep coming. It never blocks and never re-reads every run on each autosave. | Problems reach the person before the users of the flow. |
| R15 | **UI.** Flujo › **🩺 Revisión** contains counters, "↻ Revisar ahora", "🧪 Ensayo", "🤖 Revisión con IA" (token estimate shown before launching), finding cards (evidence, fix, a separate "⚠ amplía el acceso", Aplicar / Discutir / Descartar), the AI review (sources, dissent, "sin evidencia verificable"), "No se pudo verificar", the flow's rules with what they guarantee, and the `_review` chat. ⚙ Configuración › **Reglas** holds the machine rules. Chat proposal cards show the policy and the new step, and confirm widening apart. | One place to decide; nothing applies itself. |

## Adversarial code review (before closing) — fixed

**Proposals**
- A policy proposal could switch a rule off or replace it silently. Proposals now always add an **enabled** rule, and replacing an existing rule of the same type counts as widening.
- `patchProblem` only looked at `Bash`. It now also blocks `PowerShell` without a pattern, wildcards (`Bash( * )`, `Bash(*:*)`) and patterns that launch another shell (`Bash(powershell:*)`, `cmd`, `bash`…).
- `confirmWiden` was a boolean. The UI now sends the list it showed, and the server asks again if something else widens (`true` stays for API callers).
- A gate step inserted by `structure` used to steal conditional and routed arrows. Only plain arrows move now.

**Rehearsal**
- Hooks and command assertions still ran in a rehearsal. They no longer do.
- The skip check now also looks at the values inserted into the command.
- A broader `REHEARSAL_SKIP_RE` also skips deletes, git pull/commit, other curl/HTTP forms, `gh`, deploys and test/tool launchers.
- The UI says honestly that an unrecognized command runs.
- A POST to a `/search` endpoint counts as a read.

**Review**
- Secrets reached the dossier when the check looked at the variable's value. It now masks by the variable's NAME (`SECRET_NAME`) plus anything shaped like a token, and `</untrusted-data>` inside run text is neutralized.
- Reviewers now work in an empty folder, never the user's home.
- The `startReview` slot is reserved before the first await, so a double click or a run starting meanwhile is seen.
- Merging only joins findings of different reviewers. A quote must be at least 12 characters and is checked against values, never against keys.
- Rehearsal denials no longer produce R-DENY or false-success findings.
- Fingerprints are stable (unique tool set; R-FLAKY without its count).
- A failing lint is cached, so it can never become a hot loop.
- 🔔 does not count proposals that cannot be applied.

**Performance and wording**
- `store.listRuns` caches run summaries by mtime and size, and digests are looked up before reading a run file.
- The `noExternalWrites` guarantee text was narrowed to what it really blocks.

## Coverage of the 13 problems (honest)

| # | Problem | Covered by |
|---|---|---|
| 1 | MCP not loaded | R-MCP (definition, against the CLI init) + runs |
| 2 | Jira writes | R-WRITE-EXT + `noExternalWrites` (enforced in AI steps; flagged ⛔ in commands) |
| 3 | Missing skill | R-REF |
| 4 | cwd / isolation | R-CWD; a worktree is a design choice → AI review |
| 5 | `cd &&` / `VAR=x` | R-DENY after a run or rehearsal, with the shell rule and the read commands |
| 6 | Bash 10 min, false success | R-LONG-BASH (before), R-FALSE-SUCCESS / R-BASH-TIMEOUT (after), `bashTimeoutMin` |
| 7 | Orphan Chrome | P-HEADLESS + "Cerrar esos procesos" |
| 8 | Wrong environment | `defaultEnv` policy (enforced as the variable default), captured once |
| 9 | Scope without the code | AI review (structure proposal); the real fix is a step that reads the commits (see the SBK flow) |
| 10 | Shared env data / parallel | `noParallelRuns` (enforced); missing data only shows when running |
| 11 | Trailer and author | `noCoAuthorTrailer` + `gitAuthor` (enforced) |
| 12 | 25-min cap | R-SLOW / R-BASH-TIMEOUT; the runner cap belongs to the user's script |
| 13 | Ticket in Done | `ticketStatus` + POL-TICKET-GATE + a `structure` proposal (a gate step), because a prompt rule does not stop |

## Round 2 (2026-11-18): the reviewer investigates and reshapes the flow

Why: on the real SBK flow the review agent was compared with a manual analysis of the same run. It saw the 2-hour timeout but could only *insert* steps (not split the automation step per environment), and it could not find that 7 of 8 regression failures were already fixed in an unmerged branch (it only had a 300-character digest of each step and no access to the repositories).

| Capability | How |
|---|---|
| Full evidence | Each review writes `INDICE.md` plus one file per run and step in its own folder under the temp dir. Each file holds every command, its result and the output, with secrets masked. That folder is the reviewer's working folder. The 6 newest folders are kept. |
| Read-only git | `node bin/review-git.mjs <repo> <subcommand> [args]` is the only Bash the reviewer may run. Repos are the flow's folder plus absolute folders in its variables (`name=path` lists included), never paths taken from a run. Only read subcommands are allowed. `--output`, pagers, external diff and textconv, `-c`, and creating or deleting refs are refused. No shell is used. |
| Reshape | `structure` proposals accept: `splitStep` (part 1 keeps its id, memory and chat; the other parts inherit tools, permissions and limits and are chained after it), `addSteps`, `removeSteps` (arrows are reconnected), `addEdges` / `removeEdges`, and `steps` (field changes, applied last). A proposal is applied all or nothing, and one that creates a cycle is rejected. Removing a step or an arrow is confirmed apart, like a widening. |
| Investigator (phase 0) | Before the two reviewers, a third call whose only job is finding causes. It must use the evidence and git, and it returns facts with citations. The app re-checks every fact: the quote must be in the file it names (inside the evidence, a repo or a skill), or in the output of the git command it names, run again through the helper. Verified facts go to both reviewers (who can cite them as `fact` evidence) and to the panel ("🔎 Hechos investigados"). Unverified ones go to "No se pudo verificar". Without this phase, the first real review answered from the digest without opening a single file. |
| Policies | Reviewers may not propose fixes that contradict a policy (notes included). If they disagree with one, they must raise it as a `policy` finding with no fix. In the first real review they proposed SynergyNew against the "ambiente habitual" note. |
| Readable folders | Absolute folders named in the flow's variables (for example the work folder that holds the runner script) can be read with Read/Grep/Glob. The home folder itself and drive roots are excluded. These files are not masked: they are the same files the flow's own steps read. |
| JSON repair | A reviewer that returns broken JSON gets one retry, without tools, asking it to fix the JSON. |
| Chat | The `_review` chat has the same evidence and git access. |
| Apply | `POST /api/flows/:id/reviews/:rid/apply-safe` and the "✅ Aplicar las seguras" button apply only proposals with no error, no widening and no removal, after saving a version. Applying any single review proposal also saves a version first. |

The prompt tells reviewers to find the cause before proposing:
- read the evidence first;
- for failing tests, look in git for a fix in another branch;
- for a timeout, split the step rather than only raise the limit.

E2E: `test/e2e/25-flow-review-investigate.test.mjs`.

**Result on the real flow** (three real reviews on 2026-11-18, about $0.30–0.51 and 1 minute each):

| | Before | After |
|---|---|---|
| Splitting the automation step per environment | Proposed as inserted steps, with a 0-character diagnosis | Proposed as a `splitStep` with dev, qa and ppd parts |
| Causes found | None beyond the summary | A run hung 60 minutes on a DNS error; the set-limit failures; the fix commit is only in `synergy-web` main (from git), so the Alcance step misses it by searching only branches and PRs |
| Policy conflict | Proposed SynergyNew | Leaves the SynergyNew question to the person |

Still missing: the investigator did not look in the test repo for the branch that already updates the set-limit texts (PR #19), even though the prompt asks for it. The next step is to make that search deterministic, running `log --all -S` on the expected texts of failing assertions.

## Not done (deferred)

- A gate "listo para compartir" before export.
- Rules shared by repository.
- Learning new rules automatically from accepted and dismissed findings.
- Reviewing the referenced skill and agent files themselves.
- An OS notification for review items.
