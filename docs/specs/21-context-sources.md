# 21 · 📎 Context: consultation sources

Status: Implemented (2026-11-12). Verified by `test/e2e/14-context-sources.test.mjs`.

## Request (user, 2026-11-12)

> "Sigo sin ver dónde está el contexto. Este contexto puede ser una carpeta con documentos, un documento, una página de internet, un Confluence, un ticket de Jira, una iniciativa… incluso un .md."

The user then clarified:

> "No va dentro del prompt. Cada skill tiene que tener el ruteo a su contexto si fuera necesario, pero ya es definición de la skill. Lo que digo es que si es fuente de consulta esté disponible."

## Decisions

| # | Decision | Why |
|---|---|---|
| C1 | A visible **📎 Contexto** section sits in each step's Config, right below its kind. A **📎 Contexto del flujo** section in Flujo applies to every step. A node with sources shows a 📎 badge with their count. | The old "Contexto" was a text field hidden under Avanzado, and the preview box was also called "Contexto", so users could not find it. The preview box is now "👁 Lo que recibe el modelo", and the old field is "Notas fijas en el prompt". |
| C2 | Source types: **Documento** (any file: .md, PDF, Word, code…), **Carpeta**, **Página web**, **Jira** (one or several keys, an initiative or epic with "incluir hijos", or a JQL query) and **Confluence** (URL, id or title, optionally with child pages). A document can also be uploaded; it is stored in `data/context-files/<flow>/`. | Covers the cases the user listed. |
| C3 | Sources are **not pasted into the prompt**. The model gets: (a) a short index section, "Fuentes de consulta disponibles", saying what each source is, where it is and which tool to use; (b) the access to reach them: `--add-dir` plus Read/Grep/Glob for files and folders, WebFetch for pages, and the Atlassian MCP read tools for Jira and Confluence (added to `--allowedTools`). Nothing is read or fetched in advance. | The skill, agent or role decides when to consult them; the app only makes them available. |
| C4 | References accept templates (`{{vars.issue}}`, `{{input}}`). Variables passed for one run apply to that run. | "The ticket or folder that comes as input". |
| C5 | Each source can be switched off without being deleted, and can carry a short note saying what it is for ("reglas de negocio de apuestas"). The model sees that note. | |
| C6 | A ✓/✗ next to each source (`POST /api/context/check`): the file or folder exists (with size or file count), the page answers (HTTP status and title, or a warning when it is a login page), and a URL that looks like Confluence or Jira gets a hint to use that type instead. Jira and Confluence cannot be checked without running, and say so. A folder browser (`GET /api/fs/list`) lets you pick paths. | Feedback without running the flow. |
| C7 | Step chats get the same index and access, so you can ask the chat to look something up. Command steps ignore sources. A missing source becomes a warning on the step and in the preview; the run goes on. | |
| C8 | Sources are part of the flow definition: they are versioned, merged between tabs and undoable. The server sanitises them on save: known types and fields only, bounded lengths, at most 50. | |

## Data

`flow.contextSources[]` and `step.contextSources[]` hold entries of the form `{id, type: file|folder|url|jira|confluence, label?, path?|url?|ref?, children?, note?, disabled?}`.
