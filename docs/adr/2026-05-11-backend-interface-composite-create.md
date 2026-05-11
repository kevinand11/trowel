# Backend interface: composite createPrd, lookup-and-repair resume

The `Backend` interface collapses PRD creation into a single `createPrd(spec, ctx) → { id, branch }` method, rather than the granular `proposeIdentifier`/`branchFor`/`writeArtifacts`/`createRemoteObject`/`linkBranchToPrd` quintet initially sketched. The granular shape assumed the `file` backend's natural ordering (id → branch → files → remote); for the `issue` backend that order is wrong (remote → branch → files), and forcing a uniform sequence required a `'pending'` sentinel id and a backend-specific fork inside the orchestrator. A composite method lets each backend own its ordering; the orchestrator stays backend-agnostic.

Discovery and slice operations (`branchForExisting`, `findSlices`, `attachSlice`, `sliceMarker`, `listOpen`, `close`) stay granular on the interface — those are legitimately orchestrator-driven. Only the creation flow collapses.

On resume (`trowel start --prd <id>`), the orchestrator calls `branchForExisting(id)`, which queries the backend's authoritative source of truth (GitHub's development-link metadata for the `issue` backend) and creates the linked branch if it is missing. Resume is therefore an idempotent repair, not a pure lookup — it covers the case where `createPrd` was interrupted between the remote object being created and the branch being linked.

## Considered options

- **Granular methods with an orchestrator-side fork per backend.** Rejected: bleeds backend-specific ordering into `src/commands/start.ts`; every new backend would change the orchestrator.
- **Backend declares an ordered recipe; orchestrator iterates.** Rejected: over-engineered DSL for three backends.
- **Reconstruct the branch name on resume by re-running the title slugifier.** Rejected: titles can be edited on GitHub after creation, causing silent divergence between the computed name and the actual linked branch.
