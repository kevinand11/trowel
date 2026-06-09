---
status: superseded by 2026-06-09-remove-slice-command-surface
---

# Slice commands require Change id context

Slice-addressed commands now require both the Change id and Slice id (`trowel slice status <change-id> <slice-id>`, and likewise `implement`, `audit`, and `review`) instead of resolving a globally unique Slice id through `Storage.findSlice(sliceId)`. Although Slice ids remain globally unique, passing the Change id keeps orchestration explicit: command handlers load the parent Change, read that Change's Slices through `findSlices(changeId)`, and run common enrichment/classification in one path. This removes `Storage.findSlice` from the Storage interface and avoids storage implementations duplicating parent-discovery behavior.

This amends [2026-05-17-file-storage-deterministic-shared-ids.md](./2026-05-17-file-storage-deterministic-shared-ids.md): its shared integer id allocation remains, but the CLI simplification to slice-id-only commands and the `Storage.findSlice` method are intentionally reversed.
