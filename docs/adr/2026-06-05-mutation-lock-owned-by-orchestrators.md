# Mutation lock is owned by orchestrators, not Storage

The Mutation lock is acquired by command/work orchestrators around the smallest coherent operation that mutates trowel-managed state. Storage implementations are pure persistence and must not acquire the lock internally; they assume mutating callers already hold it when serialization is required.

This replaces the earlier layered-lock design where file Storage write methods also acquired the lock and `withMutationLock` was reentrant to tolerate nested lock calls. Coherent-operation locking prevents half-materialized Change/Slice state from being observed between related writes, keeps long-running Grill and Turn execution outside the lock, and applies uniformly to file and issue Storage.
