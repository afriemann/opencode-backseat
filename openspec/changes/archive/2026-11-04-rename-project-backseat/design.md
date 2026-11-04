# Design

## Context

The approved proposal fixes the rename boundary. Existing runtime components and persisted record structure remain the architecture; this change needs no new service, abstraction, or dependency.

## Decisions

- **One coupled identity change.** Package metadata, callable names, permission prefixes, RPC/plugin identity checks, native integration identifiers, and the shared authority symbol move together in one shipped revision. Treating them as independent display strings risks denying legitimate calls or separating participants that must share authority. Staged renaming is rejected because compatibility bridges would enlarge the identity surface outside the approved scope.
- **Keep enforcement in place.** Rename identity literals at their existing enforcement points in `src/tools.ts`, `src/rpc.ts`, `src/native-connection.ts`, and `src/ownership.ts`; do not recreate or consolidate their checks. Authentication, authorization, consent, ownership, runtime-store conflict detection, and uncertain-delivery handling retain their control flow. This minimizes safety-sensitive change and preserves established failure boundaries.
- **Separate store location from record representation.** In `src/storage.ts` and its existing callers, rename default-location identity without changing serialization or explicit `dataDir` selection. Automatic discovery or migration is rejected: it adds state-selection ambiguity and recovery machinery without an approved need. An explicitly selected store continues through the same conflict checks.
- **Keep role semantics separate from identity spelling.** Embedded role instructions in `src/coordinator-agent.ts` receive only the scoped identity substitutions through the instruction-file owner. No role redesign or command-routing change is justified.

## Risks/Trade-offs

The atomic revision boundary avoids mixed internal identities, not mixed-version interoperability. Old configurations can fail closed; this is preferable to hidden aliases. The renamed default location exposes a separate store; retaining old data without discovery makes recovery an explicit operator choice. Scaling, delivery uncertainty, and process-failure behavior receive no architectural change.
