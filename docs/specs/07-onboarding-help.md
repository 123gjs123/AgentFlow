# 07 — Onboarding, help and simplified configuration

**Status:** Implemented

## Summary

New users should be able to build and run a useful flow without reading docs or touching advanced settings. The app provides:
- A guided tour.
- A help menu with a first-steps checklist.
- Step templates and access presets.
- AI flow generation from a plain-language description.
- Copy-ready invocation snippets.

## Requirements

| ID | Requirement |
|---|---|
| ONB-1 | **Guided tour** (9 stops) that spotlights the main areas: flows, add step, canvas, side panel, chat, run, usage badge, help. It starts automatically on the first visit, can be replayed from Help, and supports keyboard navigation (←, →, Esc). |
| ONB-2 | **Help menu** (❔) with sections: Getting started (checklist), Concepts, Configuration, Variables, Access, Chats, Hooks, Invoke from outside, FAQ. |
| ONB-3 | **First-steps checklist** that ticks itself from real state: flow created, step added, steps connected, flow run, chat used, memory stored, external invocation snippet copied. |
| ONB-4 | **Step templates** (＋ Step), grouped as Understand / Design / Build / Publish / Blank. Each template sets the kind, task and access level. Templates that reference a missing skill show a warning. |
| ONB-5 | A new step is connected after the currently selected step. |
| ONB-6 | **Simplified step form:** Kind, Agent/Skill selector, "What does it do?", "How does it work?" and Access. Context, model, effort, permission mode and exact tools sit in a collapsed **Advanced** section. |
| ONB-7 | **Create with AI:** the user describes the flow. Sonnet (no tools) designs 2–7 steps from the user's own skills and agents catalog, with the minimum access per step, and the result opens for review. |
| ONB-8 | **Invoke tab and section:** copy-ready snippets for Claude Code (MCP), terminal, HTTP, PowerShell, Jenkins, webhook and remote. They are filled in with the real paths, port, flow name and (optionally revealed) token. |
| ONB-9 | Welcome screen when no flow exists, with calls to action: create with AI, demo QA flow, empty flow. |

## Built-in templates

| Group | Templates |
|---|---|
| Understand | Read Jira ticket · Analyse requirement · Review repo changes |
| Design | Design test cases (`qa-test-architect`) · Adversarial review (`qa-adversarial`) |
| Build | Write automation (`qa-automation`) · Run tests (command) |
| Publish | Comment on Jira · Create Jira bug (fills the Environment field, e.g. "QA, PPD") · Publish to Confluence |
| Blank | One per kind |

## Acceptance criteria
- On a clean browser profile, the tour opens and each stop highlights the right element.
- A user can go from the welcome screen to a running 3-step flow using only templates, without opening Advanced.
- The checklist updates as soon as each action happens.
