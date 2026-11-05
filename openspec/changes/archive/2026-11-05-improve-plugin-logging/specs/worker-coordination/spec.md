## ADDED Requirements

### Requirement: Host-integrated operational diagnostics

Backseat SHALL emit structured operational diagnostics through host logging, subject to the host minimum level.

#### Scenario: Routes diagnostics through host logging

- **WHEN** lifecycle, tool, RPC, native read, or background operations complete, fail, or degrade
- **THEN** host logs receive lifecycle information, default-visible failures and degradation, and opt-in debug details including read phases, elapsed time, aggregate counts and continuation presence
- **AND** independent diagnostic correlation connects related internal work without identifying host sessions

### Requirement: Diagnostic privacy boundary

Backseat SHALL restrict diagnostic records to a closed allowlist of fixed event, operation, phase and failure categories, nonnegative finite durations and counts, continuation-presence booleans, and independent diagnostic-only tokens.

#### Scenario: Excludes sensitive diagnostic data

- **WHEN** input, native metadata or an exception contains sensitive or arbitrary values at any logging level
- **THEN** diagnostics exclude exception objects, messages and stacks, URLs, paths, registration contents, prompts, titles, payloads, native/session identifiers, cursors, continuation handles, possession proofs and content-derived hashes
- **AND** existing detailed user-facing registration errors remain unchanged

### Requirement: Diagnostic failure isolation

Backseat SHALL preserve coordination results, original errors, permission checks, cancellation and cleanup behavior when diagnostic processing fails.

#### Scenario: Logging failure preserves coordination outcomes

- **WHEN** diagnostic token generation, record processing or host logging fails during an operation
- **THEN** its result or original error remains unchanged and required cancellation and cleanup still occur
- **AND** logging causes no retries, recursive logging or fallback sink writes
