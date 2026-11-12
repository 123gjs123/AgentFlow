# 20 · Undo/redo, versions, moving arrow ends, chat keys

Status: Implemented (2026-11-12). Verified by `test/e2e/13-history-versions-chat.test.mjs`.

## Request (user, 2026-11-12)

1. "La flecha del output no se puede reacomodar a otro punto."
2. Restore changes, or version them with automatic saves every X time.
3. Undo with Ctrl+Z and redo, plus the usual back and forward arrows at the top.
4. In the chat, Enter should send and Alt+Enter should add a new line. Keep the button.

## Decisions

| # | Decision | Why |
|---|---|---|
| H1 | The ends of the selected arrow are visible grab points, with a larger radius (18 px) and a `move` cursor. Dragging an end to another dot moves it (reconnect). Drawing again between two boxes that are already connected **moves** the existing arrow to the chosen dots, instead of rejecting the new one. | The reconnect worked, but its 10 px grab circle was invisible. Users drew a new arrow and got "ya están unidas". |
| H2 | Undo/redo is kept per tab and per open flow (`client/src/history.js`). Every local edit is recorded as {before, after} of the flow **definition**. Edits within 1 s are grouped into one action (a typing burst). The history keeps up to 100 actions. Shortcuts: Ctrl+Z undoes; Ctrl+Y or Ctrl+Shift+Z redoes (⌘ on macOS); the ↶ ↷ buttons do the same. | These are the usual combinations. |
| H3 | Undo applies only **the change of that action** on top of the current flow, using the same 3-way merge as spec 19 (base = after, local = current, remote = before). Changes that arrived later from another tab, a chat proposal or a hook are kept. Run state (lastRun, memory, pins, sessions) is never undone. | A naive "restore the previous snapshot" would silently revert other tabs' work. |
| H4 | Inside a text field, Ctrl+Z is the browser's own undo of that field. | Expected behaviour while typing. |
| H5 | Versions are snapshots of the definition stored in `data/versions/<flow>/`. While a flow is being edited, a version is taken at most every `versionEveryMin` minutes. The default is 5 (`AFS_VERSION_EVERY_MIN`), it is set per flow in **Flujo → Versiones**, and 0 turns it off. The first edit also keeps the "Estado inicial". Named versions ("Guardar versión") are kept forever. The last 30 automatic ones are kept. | Automatic saving every X time, without timers running when nobody edits. |
| H6 | **Restore** first saves the current state as "Antes de restaurar …", so a restore can be undone. It keeps the run state of steps that still exist and bumps the revision (other tabs merge). It is refused with `RUN_IN_PROGRESS` while a run is active. | Restoring must never lose work. |
| H7 | Chat keys: Enter sends; Alt+Enter (and Shift+Enter) inserts a new line. The insertion is native (`insertText`), so the caret and the field's own undo behave while typing fast. IME composition is respected. The Enviar button stays. | |
| H8 | A tab applies every new revision of its flow, even one it caused itself. | Restore and reset are transformed on the server. For a plain save the result is identical. |

## API

- `GET  /api/flows/:id/versions`: version list (metadata, steps/arrows count).
- `POST /api/flows/:id/versions {label}`: save a named version.
- `GET  /api/flows/:id/versions/:vid`: one version with its definition.
- `DELETE /api/flows/:id/versions/:vid`
- `POST /api/flows/:id/versions/:vid/restore`
