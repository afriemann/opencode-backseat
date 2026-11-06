# Design

## Context

See proposal.md for scope. Metadata conversion, bounded hydration and opaque continuation exist in `src/native-sessions.ts` and `src/tools.ts`. OpenCode 2.2.5 location `form.list` returns location-tagged pending `Form.Info` summaries; membership needs no detail read.

## Decisions

- Pass the normalized result limit into the native inventory query, capped by the existing catalog bound. Consume one native page per call, retaining its cursor independently of surviving matches. This budgets candidates rather than scanning until the result limit is filled and leaves the shared 10-second connection deadline untouched.
- Reuse metadata conversion and one metadata-selection predicate for prehydration exclusion and final filtering. Apply status selection only after hydration. Recheck refreshed project, location, agent, hierarchy and archive metadata before returning rows. Apply the same selection discipline to buffered continuation rows; retain existing normalized query, ordering and continuation ownership machinery.
- Memoize one lazy location-form snapshot promise per selected location inside each refresh, alongside the existing permission snapshots. Validate the location envelope, bounded aggregate size and usable, nonduplicated form identities before grouping by session. Retain rejected promises within that refresh so failures do not trigger per-session retries. Release all snapshots when the refresh ends.
- Extend the existing ask-reading path with an optional inventory snapshot input. Inventory derives form asks from validated pending summaries without session-form or form-detail calls. Without that input, shared non-inventory consumers retain their session-scoped reads and eligibility semantics. Keep detail, inbox and before/after activity checks for status classification.
- Treat unavailable, malformed or oversized form snapshots as unknown status for affected location rows through existing degradation handling. Keep other locations independent. Reuse existing helpers and bounds rather than adding modules, persistent caches or alternate inventory paths.

## Risks / Trade-offs

- Smaller candidate pages increase continuation calls and permit short or empty filtered pages; native cursor retention preserves progress.
- Shared snapshots are observations, not atomic state. Refresh-local lifetime limits staleness without claiming stronger consistency.
- Aggregate form bounds can degrade a location containing many unrelated asks; explicit unknown results avoid false inactivity.
- Slow reads can exhaust the deadline; reduced request volume is not a latency guarantee.
