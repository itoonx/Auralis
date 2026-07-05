// The concurrent-dedup claim DECISION, as one pure function — the single policy every runtime resolves
// against. oracle-lite calls it server-side so the registry is shared across processes AND heterogeneous
// agents (Claude, or anything that can reach the brain); each agent runtime only needs a thin call in.
// Kept dependency-free so the Bun server can import it without pulling in the agent SDK.
export interface ClaimResult {
  ok: boolean; // true = this worker may explore the target
  owner: string; // the worker that owns it
  fresh: boolean; // true only when THIS call created the claim (used for counting)
}

// First worker to claim a target owns it; a later, DIFFERENT worker is told to skip. Re-claiming your
// own target is idempotent. Synchronous + no await, so a single-threaded event loop makes it atomic.
export function resolveClaim(claimed: Map<string, string>, target: string, by: string): ClaimResult {
  const owner = claimed.get(target);
  if (!owner) {
    claimed.set(target, by);
    return { ok: true, owner: by, fresh: true };
  }
  return { ok: owner === by, owner, fresh: false };
}
