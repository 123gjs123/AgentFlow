# 13 — Skill sources: load skills from a URL, a folder or a zip

**Status:** Proposed

## Summary

Today a skill step can only use skills that are already installed in Claude Code: user skills, claude.ai skills, plugins and project skills. This spec lets users **add a skill from a URL, a local folder or a zip file**, either for one flow or for their whole Claude Code. It also replaces the long, flat skill dropdown with a searchable picker grouped by source.

## Goals
- Bring a skill in from wherever it lives (a Git repo, a shared drive, a colleague's zip) without leaving the app.
- Keep flows isolated (spec 11): by default an added skill is visible **only to that flow**.
- Make flows portable (spec 09): a flow can carry the skills it depends on.
- Be safe: skills can contain scripts, so nothing is installed without a review.

## Non-goals
- A public skill marketplace.
- Editing skills in the app beyond what improve mode already does (spec 04).

## What a skill is

A skill is a folder with a `SKILL.md` file. The file has YAML front matter (`name`, `description`, optionally `allowed-tools`) followed by instructions. The folder can also hold optional extra files: references, templates and scripts. Claude Code discovers skills in these places:

| Location | Scope |
|---|---|
| `~/.claude/skills/<name>/` | User: every Claude Code session |
| `<cwd>/.claude/skills/<name>/` | Project: only sessions whose working directory is `<cwd>` |
| Plugin cache / claude.ai | Managed by Claude Code |

Since each flow runs with its own working directory, `<flow folder>/workspace/` (spec 11), a skill installed in `<flow folder>/workspace/.claude/skills/` is **automatically available to that flow only**. No Claude Code change is needed.

## Requirements

| ID | Requirement |
|---|---|
| SKSRC-1 | The skill picker has an **"＋ Add skill"** action with three options: **From URL**, **From folder**, **From zip**. |
| SKSRC-2 | **From URL** accepts: a Git repo URL (optionally with `#branch:path/to/skill`), a GitHub/Bitbucket "tree" URL pointing at a skill folder, a URL to a `.zip`, or a raw URL to a single `SKILL.md`. Only `https://` URLs are accepted. |
| SKSRC-3 | **From folder** accepts a local path. The user chooses between **copy** (a snapshot) and **link** (used in place, so edits in the folder show up at once). |
| SKSRC-4 | **From zip** accepts a file upload (drag & drop) or a local path. |
| SKSRC-5 | A source may contain several skills. Any folder with a `SKILL.md` counts as a skill. The user picks which ones to add. |
| SKSRC-6 | **Install scope:** *This flow* (default, `<flow>/workspace/.claude/skills/`) or *My Claude Code* (`~/.claude/skills/`, affects every session; requires explicit confirmation). |
| SKSRC-7 | **Validation:** `SKILL.md` exists, its front matter parses, and `name` and `description` are present. The name is unique within the target scope; on a conflict the user picks rename, replace or cancel. |
| SKSRC-8 | **Review before install:** the app shows name, description, `allowed-tools`, the file list (scripts and executables flagged) and total size. Nothing is written until the user confirms. |
| SKSRC-9 | **Safety limits:** zip ≤ 20 MB and ≤ 500 files. Paths that escape the folder (zip-slip, `..`, absolute paths) are rejected, and so are symlinks. Downloads go to a temporary folder and are extracted there. Nothing is executed during install. |
| SKSRC-10 | **Origin tracking:** each installed skill gets an `.afs-origin.json` file with `{type: url\|folder\|zip, source, ref/branch, sha256, installedAt}`. |
| SKSRC-11 | **Updates:** skills from a URL or a linked folder show "Check for update" and "Update". The check reuses the source-check engine (spec 10): git head, ETag or hash. Updating shows a diff of `SKILL.md` and asks before replacing. |
| SKSRC-12 | **Export / import (spec 09):** flow-scoped skills are included in the flow bundle. Each one is embedded as files (if under 5 MB) or referenced by its origin URL. On import they go through the same review as SKSRC-8. |
| SKSRC-13 | **Picker UX:** searchable combobox, grouped by source (*This flow*, *User*, *claude.ai*, *Plugins*), showing each skill's description on hover or selection. Typing filters by name and description. |
| SKSRC-14 | **Remove:** flow-scoped skills can be removed from the flow. User-scope skills are only removed after confirmation, and claude.ai and plugin skills cannot be removed (they are managed elsewhere). |
| SKSRC-15 | Downloads honour the corporate proxy and system certificate store. The app uses system CAs and does not disable TLS checks. |

## Design

**Server**
- `server/skills.js`:
  - `resolveSource(input)` downloads or clones into `os.tmpdir()/afs-skill-<uuid>`. Git uses `git clone --depth 1` (with `--branch` when given); zip URLs use `fetch`; tree URLs map to the host's archive download plus the sub-path.
  - `scan(dir)` returns `[{name, description, allowedTools, files[], size, hasScripts}]`.
  - `install(candidate, scope, flowId)` copies, or records a link in the flow config.
- **Endpoints:**
  - `POST /api/skills/inspect {url | path | zipBase64}` returns `{token, skills[]}`. The temporary folder is kept for 15 minutes.
  - `POST /api/skills/install {token, names[], scope, flowId, mode: copy|link}`.
  - `GET /api/skills/:name/origin`, `POST /api/skills/:name/update`, `DELETE /api/skills/:name?scope&flowId`.
- **Catalog** (`catalog.js`): adds `<flow workspace>/.claude/skills` and linked folders, with `source: "flow"` or `"linked"`.

**Client**
- `SkillPicker` component: the combobox plus an "＋ Add skill" modal with tabs (URL / Folder / Zip), a review screen and a scope selector.
- Steps keep referencing skills **by name**. If a referenced skill is missing (for example on a machine that never imported it), the step shows a warning with "Add skill…".

## Acceptance criteria
- Pasting a GitHub tree URL of a skill folder, reviewing and installing with scope *This flow* makes the skill selectable in that flow only. Another flow does not list it.
- A zip with two skills offers both, and installs only the selected one.
- A zip containing `../evil.sh` is rejected with a clear message.
- A linked folder: editing its `SKILL.md` changes the step's behaviour on the next run without reinstalling.
- Exporting a flow with a flow-scoped skill and importing it on a clean machine makes the skill available after review.

## Open questions
- Private Git repos: use the user's git credentials (clone through their git) or a per-source token? Proposed: rely on the user's git credential manager, store no secrets.
