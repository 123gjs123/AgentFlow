# 05 — Memory

**Status:** Implemented

## Summary

Memory is a list of durable facts. Each step has its own memory and each flow has a general one. Memory is injected into prompts so that steps improve over time, always under the step's own context. Topics can be related across steps through keyword relevance, but foreign memory is always labelled as reference.

## Requirements

| ID | Requirement |
|---|---|
| MEM-1 | Each step and each flow has a memory list: `{id, text, source: run|chat|hook|manual, at}`. |
| MEM-2 | Facts are added automatically from runs and chats (`<remember>` tags) and from hooks (`ctx.remember`). They can also be added or removed by hand in the Memory tab. |
| MEM-3 | Exact duplicates are ignored. |
| MEM-4 | Step runs receive the step's memory and the flow memory in the system prompt. |
| MEM-5 | A step chat receives its own memory in `<step-context>`, plus up to 6 related facts from **other steps of the same flow**, ranked by keyword overlap with the user's message. These arrive in `<related-memory>`, tagged with the source step. |
| MEM-6 | The router sees the last 5 memory items of each step, which helps it route. |
| MEM-7 | Memory never crosses flows (spec 11). |

## Design notes
- Relevance is naive on purpose: accent-insensitive words of 4 or more characters, scored by overlap. This is cheap, predictable and needs no embeddings.
- Nodes on the canvas show a 🧷 badge with the memory count.

## Future
- Optional summarisation and compaction when a list grows past ~50 items.
- Memory expiry or pinning.
