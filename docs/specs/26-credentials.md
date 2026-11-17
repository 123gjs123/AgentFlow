# 26 · 🔑 Credenciales: one place for the tokens flows need

Status: Implemented (2026-11-17). Verified by `test/e2e/20-credentials.test.mjs`.

## Request (user, 2026-11-17)

> "Usar el token, pero creo que tendríamos que tener una pantalla de configuración donde cargar las credenciales de todo, ¿no?"

Context: the "Pull Jira" command read `Token_Jira` from a `.env` file on the Desktop. The Claude Code CLI on that machine does not load the claude.ai Atlassian connector, so Jira had to be reached with the user's own API token.

## Decisions

| # | Decision | Why |
|---|---|---|
| K1 | A **🔑 Credenciales** window (top bar), with these types: Jira/Confluence (url, user, token), Bitbucket (url, user, token), GitHub (url, token), Jenkins (url, user, token) and other (user, value). Each credential has a name, which is how flows reference it. | One place for every token, instead of `.env` files read by each command. |
| K2 | Stored in `data/credentials.json`. Secret fields are encrypted with AES-256-GCM, and the key lives outside `data/` (`~/.afs/credentials.key`, or `AFS_CRED_KEY_FILE`). The API never returns a secret, only `{set: true}`. Editing with the secret empty keeps the current one. | Copying, exporting or committing `data/` never leaks a token. |
| K3 | Flows use them **only in commands** (command steps and "Al terminar") as `{{cred.<nombre>.<campo>}}`. The value travels in an environment variable (like any template value), is never spliced raw (`{{{…}}}` is quoted too), is shown as `••••` in the command's inserted values, and is replaced by `••••` in stdout and stderr, so it never reaches the output, the activity or the run file. In an AI prompt the template becomes a marker, never the value, and the context box warns `CRED_IN_PROMPT`. | A token can be used, but not seen or leaked to a model. |
| K4 | Credentials used by a flow are **implicit requirements**. Preflight (UI, single step, external API, dry run) lists `Credencial x.y` when the credential or its field is missing, blocks with 412, and offers "🔑 Cargar credencial". A run started without the gate (a schedule) fails the step with `CREDENTIAL_MISSING`. | Whoever runs the flow learns exactly what to load, before anything runs. |
| K5 | "Probar conexión" does a harmless read: Jira `/rest/api/3/myself`, Bitbucket `/rest/api/1.0/users/<user>`, GitHub `/user`, Jenkins `/me/api/json`. The result is stored as `lastTest`. | Know before running that the token works. |
| K6 | Import from a `.env` file: the browser only gets the key names; the chosen value is copied on the server. | Migrating existing `.env` files without pasting tokens. |
| K7 | Credentials are never exported. Importing a flow warns which credential names this machine still has to load (same name). | Sharing flows without sharing secrets. |
