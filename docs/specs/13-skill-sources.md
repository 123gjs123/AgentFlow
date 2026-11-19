# 13 — Skill sources: load skills from a URL, a folder or a zip

**Status:** Implemented in full (2026-11-19): v1 + completion (SKSRC-11 update checks, SKSRC-12 references, SKSRC-15 explicit proxy, SKSRC-14 user skills), each with architect review, adversarial passes and real simulations

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

## Implementation (v1)

**Decisions**

**Where "This flow" skills live (no spec 11 yet).** Skills installed for a flow go in `<DATA>/flow-skills/<flowId>/.claude/skills/<name>/`. Every Claude call for that flow passes `--add-dir <DATA>/flow-skills/<flowId>`; Claude Code loads `.claude/skills` from an add-dir. I checked this with the real CLI, and it also works through a junction. The calls covered are:
- steps, the context preview and chats, through `resolveContext`;
- hooks (`hook.ai`);
- the review investigators.

A flow without skills gets nothing. When spec 11 lands, `flowSkillRoot()` is the only place to change.

**Link mode.** A directory junction (Windows, no admin) or a symlink points at the user's folder. Its records go in `links.json`, and nothing is ever written in the user's folder. The run also gets the real folder as an add-dir, so Read on the skill's files works. Link mode only works with a local folder and scope "This flow". Removing a link or deleting the flow unlinks it and never touches the target.

**Precedence.** `findSkill` prefers, in order: this flow, linked, project, user, claude.ai, plugins. On install for a flow, a name that already exists as a user or project skill is a conflict, because Claude Code would show that one instead. Replacing is allowed only inside the same target folder.

**Sources.**
- **Git.** Git repos and tree URLs (GitHub, Bitbucket Cloud and Server, GitLab, and `repo.git#branch:path`) are cloned with the user's git: `--depth 1`, plus sparse checkout for a sub-path. The clone runs:
  - with an empty `core.hooksPath` and `--template=`;
  - with `core.symlinks=false`, no LFS filters and no submodules;
  - with only the https protocol;
  - after `--`.

  Private repos use the user's credential manager; no secret is stored.
- **Zip and SKILL.md.** `.zip` URLs and single `SKILL.md` URLs are downloaded with `fetch`, which uses the system CAs from `certs.js`; TLS checks are never disabled. Redirects are followed by hand, at most 5, each re-checked as https plus the host check.
- **SSRF.** This machine and link-local addresses are blocked (`169.254/16` covers cloud metadata). Private networks are allowed, because corporate Bitbucket and GitLab live there.

**Zip.** `server/unzip.js` is a strict reader with no dependency. It accepts stored and deflate only and verifies the CRC. It rejects:
- zip64 and encrypted entries;
- symlinks;
- `..`, absolute paths, drive letters and backslashes;
- `:` (alternate data streams), Windows reserved names, trailing dots or spaces;
- duplicates when compared without case.

Limits are 20 MB, 500 files and 50 MB unpacked. Every entry is validated before anything is written, and the destination real path is checked again.

**Review before install.** `inspect` keeps the downloaded or extracted folder in a temp dir for 15 minutes and returns a token. The review shows name, description, allowed-tools, files with ⚠ scripts, size and problems. A local folder is read in place, and its hash is checked again at install (`SOURCE_CHANGED`). Each installed skill gets `.afs-origin.json` with `{type, source, ref, subPath, sha256, installedAt}`.

**Endpoints**

| Endpoint | Purpose |
|---|---|
| `POST /api/skills/inspect` | `{url}`, `{path}` or `{zipBase64, fileName}` |
| `POST /api/skills/install` | `{token, names, scope: flow\|user, flowId, mode: copy\|link, confirmUser, resolve}` → 409 `SKILL_EXISTS` with `conflicts` |
| `GET /api/flows/:id/skills` | the flow's skills |
| `GET /api/skills/:name/origin` | where an installed skill came from |
| `POST /api/skills/:name/update` | `{previous, current, changed, token}` |
| `DELETE /api/skills/:name` | scope `user` needs `confirm=1` and only works on skills the app installed |

`GET /api/catalog?flow=` adds the flow's skills.

**Deferred**
- SKSRC-11: the 🔔 Novedades check through spec 10. The "Buscar actualización" button with a diff is in.
- SKSRC-12: referencing a skill by its origin URL. A skill over 5 MB is listed as not embedded, so the person adds it by hand.
- Duplicating a flow does not copy its skills.

**Client.** `SkillPicker` is a searchable combobox grouped by origin, with the selected skill's description. It warns when a skill is missing from this machine, and offers "Quitar del flujo" and "Buscar actualización". The "＋ Agregar skill" modal has URL, folder (copy or link, with Examinar…) and zip (drag & drop or path) tabs, then the review, the scope selection with confirmation for "Mi Claude Code", and the rename, replace or don't-install choice on a conflict. On import, the bundle's skills open the same review.

**Tests.** `test/e2e/31-skill-sources.test.mjs` runs offline. GitHub URLs go to a local repo through git `insteadOf`. HTTPS goes to a local server with a fixture certificate trusted through `NODE_EXTRA_CA_CERTS`, and a second, untrusted certificate proves that verification stays on. Zips are built by hand.

**Real simulation.** I ran an isolated server with the real Claude CLI. A skill from a zip, installed for flow A, was used by A's step, which returned the skill's secret word. Flow B did not see it, and nothing was written to `~/.claude`.

### First adversarial pass

The pass found 3 high, 3 medium and 4 low findings. All are fixed, with tests in `31-skill-sources`.

**High**
- **H1 — an install for "Mi Claude Code" deleted folders the app had not installed.** It deleted one with another `name`, and one without a SKILL.md. Now a folder that already exists is always a conflict, and only one with `.afs-origin.json` (or a link of this flow) can be replaced.
- **H2 — SSRF through mapped IPv6.** `[::ffff:127.0.0.1]` and `[::ffff:169.254.169.254]` got through. The check now uses `net.BlockList`, which also covers IPv4-mapped addresses, IPv4-compatible addresses and NAT64.
- **H3 — git followed redirects to loopback.** Git now runs with `http.followRedirects=false`, and the connection is pinned to the checked addresses (`http.curloptResolve`).

**Medium**
- **M1 — this PC was reachable through its own LAN IP.** Every address of `os.networkInterfaces()` is now blocked. A download now connects to the exact address that was checked (`https.get` with its own `lookup`), so DNS rebinding no longer works.
- **M2 — export followed links inside a skill.** Hash and export now read only the skill's own folder and skip nested links. A source folder with links inside is `FOLDER_SYMLINK`.
- **M3 — a new user skill could hide a flow skill without any conflict.** Installing for "Mi Claude Code" now counts a skill with the same name in any flow as a conflict.

**Low**
- **L1 — a repeated `name:` in the front matter.** A repeated key is now a problem in the review, and a rename re-reads the front matter to check it.
- **L2 — review tokens could be reused anywhere.** A token is now used once. An import's review only installs into the imported flow (`TOKEN_SCOPE`). At most 20 reviews are pending at a time.
- **L3 — fs errors leaked temp paths.** A clash between a file and a folder, or with an 8.3 short name (`LONGFI~1.TXT`), is now a clean `ZIP_UNSAFE`. Segments that look like 8.3 short names are rejected.
- **L4 — after a rename that clashes again, the UI could not choose.** Conflicts now carry the source name, and the client keys its decisions by it.

**Accepted:** the clone is limited by time (120 s) and by sparse checkout, not by its total size. Node's `fetch` and `https` ignore `HTTPS_PROXY`. That is fine for a transparent proxy like this machine's, which needs the system CA; an explicit proxy is not supported yet.

### Second adversarial pass

All the first-pass fixes held, including the IP list against every form tried (mapped, compatible, NAT64, octal, short forms, zone ids, a trailing dot). The pass found 2 medium and 6 low issues. All are fixed, with tests.

**Medium**
- **M1 — "Replace" could create a duplicate of a user skill the app does not manage.** The duplicate went into another folder with the same `name`. Now only the destination folder itself, when the app manages it, stops being a conflict.
- **M2 — front matter written as `"name":` or `name :` slipped past the repeated-key check.** Our parser does not read those keys, but a real YAML parser does. Keys written that way are now a problem, and so are Windows reserved names (`nul`, `con`…).

**Low**
- **L1 — leftovers (`.afs-old-*`, `.afs-tmp-*`) showed up as skills.** Staging and backups now go in `<skills parent>/.afs-staging`, outside the skills folder, so neither the catalog nor Claude Code ever sees them. The catalog skips `.afs-*`.
- **L2 — a file in use made the error show internal paths.** It is now 409 `SKILL_BUSY` with a clear message, and the backup cleanup is best effort.
- **L3 — `repo#branch:path` gave git the raw URL.** With an IDN host the pin did not match. Git now gets the normalised URL.
- **L4 — temp folders were left after stopping.** `afs-skill-*` folders older than 1 h are swept at startup, and pending ones are removed on exit.
- **L5 — imports pushed out a person's open review.** Imports now have their own cap, and an import without a SKILL.md gives no token.
- **L6 — a slow server could hold a request for minutes, with a raw error.** One 90 s deadline now covers every hop, and errors while reading the body are `DOWNLOAD_FAILED`.

### Third adversarial pass

There were no high findings, and the fixes from the earlier passes held. Three medium findings are fixed, with tests:
- **"Buscar actualización" could bring in new scripts without a review.** A new `evil.ps1` came in while SKILL.md stayed the same. The update now lists the files that are added, changed or removed, with ⚠ on scripts, plus the candidate's allowed-tools and problems. "Reemplazar" is disabled when the candidate has problems.
- **A skill with another SKILL.md inside it could take the place of one of your skills in the catalog.** That is now a review problem: "Contiene otra skill adentro".
- **The front-matter check rejected valid skills** (`description: >-` with `Triggers: "x"` on the next line). Only lines at indent 0 are keys now. Quotes are removed only when they wrap the whole value. Plain values continued on indented lines are folded the way YAML does, so the review shows what Claude Code reads.

These low findings are fixed too:
- Ctrl+C / Ctrl+Break now run the cleanup of pending reviews.

These are accepted:
- A user skill cannot be replaced while some flow has a skill with the same name. That is usability only: rename it.

### Fourth adversarial pass

There were no high findings. The pass compared our parser with Claude Code's own (its front-matter regex plus a YAML parser, run with the same code). It found two medium findings and one low one. All are fixed, with tests:
- **A skill nested more than 6 levels deep got past the "otra skill adentro" check.** It then hid one of your skills in the catalog. Nested skills are now detected at any depth, using the skill's full file list.
- **The review hid what Claude Code applies beyond name and description.** Two things went unseen: `allowed-tools` written as a YAML list, and a `hooks:` key (commands that run while the skill is active). Lists are now read as "Bash, Write". `hooks` and any extra key are shown as ⚠ warnings, and the raw front matter is shown; it opens on its own when there are warnings.
- **Low — the update diff compared sets of lines, so moving a line was invisible.** For example, moving a `!`command`` out of a code fence did not show. It is now an LCS line diff that keeps the order.

### Fifth adversarial check (closed)

The three pass-4 fixes held. Nested skills are found at any depth, and the LCS diff is correct on moved lines.

The check found one medium issue: some key forms got past the review even though YAML parsers read them, so a `hooks:` key or an `allowed-tools` reached Claude Code without a warning. The forms were `? hooks` (an explicit key), escaped quoted keys (`"\x68ooks"`), merge keys (`<<: *a`), and anchors or tags.

Fix (deny by default): every top-level line of the front matter has to be a plain `key: value`, a comment or blank. Anything else is a problem, and so is a value that starts with an anchor, alias or tag. The test covers those forms and a valid front matter that uses `>-` and comments.

Spec 13 v1 is closed. It went through one architect review, four adversarial passes and a closing check. Every finding has a regression test: `31-skill-sources` has 16 tests, including the UI. The real simulation used the real Claude CLI.

**Accepted / deferred:**
- the 🔔 Novedades update check (spec 10);
- referencing skills by origin URL in a bundle;
- duplicating a flow copies its skills;
- an explicit corporate proxy (`HTTPS_PROXY`);
- replacing a user skill while a flow has one with the same name;
- `afs-skill-*` folders left by a hard kill, which are swept after 1 h.

## Completion (everything deferred in v1)

An architect review came first. It caught three things in the v1 design, all fixed:
- Imported skills lost their origin.
- Background checks could push a person's open review out of the queue.
- Git failed behind a proxy-only network.

**SKSRC-11: update checks, in the 🔔 Novedades model.** The app does the comparing, and nothing is installed without a review.
- **What is checked:** `checkSkillUpdates(flowId | '_user')` checks every app-managed skill that is not linked:
  - **Git:** `git ls-remote` of the ref, with the same hardening as a clone. A peeled tag counts, and a ref that is a 40-hex SHA is pinned and never checked. The repo is re-read only when its head moved. A commit outside the skill moves the head but is not an update, and the new head is stored so the next check does not clone again.
  - **zip or SKILL.md URL:** `If-None-Match` / `If-Modified-Since`, so an unchanged source answers 304 with no full download.
  - **Copied folder:** the hash of its source.
- **State:** it lives in `<DATA>/skill-updates/<key>.json`, and each result is bound to the installed version (`forSha`). Installing the update clears the flag on its own. A result computed for an origin that changed meanwhile, for example by an install during the check, is dropped. The write merges per skill into the current file, so a newer manual check wins.
- **Background scheduler:** first look about 2 min after boot, then every 6 h. It runs one check at a time, at most once an hour per skill, and never on quarantined flows. In the background:
  - there are no credential prompts (`GCM_INTERACTIVE=never`, `credential.interactive=never`, empty askPass);
  - a source that asks for credentials is marked and not retried until a manual check works, which avoids account lockouts;
  - an origin that came in a bundle waits for one manual check.
- **Endpoints:**
  - `GET /api/flows/:id/skills/updates`
  - `POST /api/flows/:id/skills/check-updates`
  - `POST /api/skills/check-updates` (user scope)
- **🔔 attention item `skillupd:<flow>`:** it covers the flow's own skills plus the user skills its steps use, and it opens the step.
- **Picker:** ⬆ on the skill, plus "⟳" to check them all.
- **Running flows:** replacing or removing a skill while a flow that uses it is running is refused (`FLOW_RUNNING`). That includes user skills.

**SKSRC-12: reference by origin URL.**
- **Export:** you choose how skills travel: "incluir sus archivos", "solo la URL de origen" or "no incluir". Only https origins travel; this PC's local paths never do. A skill over 5 MB with an https origin travels as a reference.
- **Import:**
  - Every origin is re-parsed; its kind, url, ref and subPath come from its source, and a head is never taken from a bundle.
  - Each skill in the review shows the URL where updates will be looked for.
  - A referenced skill has a "Traer desde <host>" button. It runs only on a click, opens the normal review and says whether the result matches the exported version (sha256).

**SKSRC-15: explicit corporate proxy.**
- **Which proxy:** `HTTPS_PROXY` / `NO_PROXY`, and also git's `http.proxy`, so Node and git take the same path.
- **How it connects:** a `CONNECT` goes to each checked address of the host in turn, and TLS is verified over the tunnel through a dedicated agent, still against the host name. A 407 is a clean `PROXY_AUTH`, and the proxy credentials never appear in errors, origins or state.
- **Names this PC cannot resolve:** they go to the proxy by name only when a person asked, never in the background. `*.localhost` names and names ending in a dot are blocked before any proxy decision.
- **Accepted:** an internal name that only the proxy resolves follows the proxy's network policy.

**SKSRC-14 and E:**
- **Managing your skills:** the catalog marks the user skills the app installed (`managed`), and the picker can update them (with confirmation) or remove them from your Claude Code.
- **Updating with a same-name flow skill:** updating a managed user skill no longer gets stuck when a flow skill with the same name already coexists. It is reported as `shadows`, and a new name still clashes.

**Not applicable:** duplicating flows, because the app has no such feature.

**Tests:** `32-skill-updates`, 12 tests, offline:
- a local git repo, an HTTPS server with ETag and delays, a local CONNECT proxy (target IP, man-in-the-middle certificate, NO_PROXY, 407, blocked IP) and a git server that asks for credentials;
- the scheduler with quarantine, and races;
- the UI.

**Bugs the tests themselves found:**
- With `agent:false`, Node ignored the tunnel and went direct. It now uses a dedicated agent.
- `localhost` was pinned only to `::1`. Every checked address is offered now.
- Git's "unable to get password" was not recognised as `AUTH_REQUIRED`.

**Real simulation on the real network:**
- **Inspect:** the real public repo github.com/anthropics/skills was cloned through this machine's TLS proxy in 5.5 s and its skills listed. A tree URL of a single skill gave that skill only.
- **Run:** the skill was installed for one flow, and the real Claude CLI used it.
- **Update check:** it worked over the real network (`ls-remote`, no windows).
- **Export:** a reference export carried its URL.

**Adversarial pass on the completion.** It found no high findings. It found two medium ones, both fixed with tests:
- by-name tunnelling and `localhost..` reached this machine's loopback through a local proxy;
- a background check overwrote a manual result.

Five low ones were fixed too:
- user skills used by a running flow;
- state left behind for a flow deleted mid-check;
- bundle origin fields that were trusted;
- background checks of imported origins before any manual check;
- the git and Node proxy decisions disagreeing.

**Closing check (closed).** It found nothing high or medium, and the five fixes held against 24 host forms (full-width, percent-encoded, numeric, IPv6 and NAT64 variants). Two low items are fixed too:
- the "checked by hand" mark no longer carries over to another version;
- a person's check never joins a background check that is already running.

Accepted:
- **Precedence, unverified.** Claude Code's own precedence between a user skill and an add-dir skill with the same name has not been verified. The app avoids the case: a new name clashes both ways.
- **Running flows.** The running-flow guard looks at skill steps only.
- **Proxies git sees and Node doesn't.** git can use proxies `proxyFor` doesn't read (`http.<url>.proxy`, `ALL_PROXY`, SOCKS); TLS still applies.
- **A hand-copied skill can look app-installed.** If you copy a skill into `~/.claude/skills` yourself and it carries `.afs-origin.json`, the app treats it as installed by the app.
