# Spec Delta

## MODIFIED Requirements

### Requirement: Host-integrated operational diagnostics

Backseat SHALL emit structured operational diagnostics through host logging, subject to the host minimum level.

#### Scenario: Routes diagnostics through host logging

- **WHEN** lifecycle, tool, RPC, native read, or background operations complete, fail, or degrade
- **THEN** host logs receive lifecycle information, default-visible failures and degradation, and opt-in debug details including read phases, elapsed time, aggregate counts and continuation presence
- **AND** independent diagnostic correlation connects related internal work without identifying host sessions
- **AND** native request diagnostics preserve their bounded category, request elapsed time, HTTP status and error-code fields through the same host projection

#### Scenario: Identifies native request failures without exposing request data

- **WHEN** a native request returns response headers or fails before receiving them
- **THEN** diagnostics identify its fixed request category and elapsed time to headers or failure, with valid HTTP status when available and a closed error-code label on exceptions
- **AND** failures are warning-level and successes debug-level, sharing the enclosing read correlation without changing the response or caller error
- **AND** each read emits at most 32 individual terminal request records and summarizes suppressed failures once per category on exit

#### Scenario: Reports active requests at the shared deadline

- **WHEN** the enclosing native-read deadline expires
- **THEN** diagnostics report the number of active fetches and each active category's count and oldest elapsed time before abort rejection removes them
- **AND** an empty snapshot reports zero without attributing the timeout to any endpoint
- **AND** completed reads emit no late request diagnostics and retain no observation listeners

### Requirement: Diagnostic privacy boundary

Backseat SHALL restrict diagnostic records to a closed allowlist of fixed event, operation, phase, failure, request-category and error-code labels, integer HTTP statuses from 100 through 599, nonnegative finite durations and counts, continuation-presence booleans, and independent diagnostic-only tokens.

#### Scenario: Excludes sensitive diagnostic data

- **WHEN** input, native metadata or an exception contains sensitive or arbitrary values at any logging level
- **THEN** diagnostics exclude exception objects, messages and stacks, URLs, paths, registration contents, prompts, titles, payloads, native/session identifiers, cursors, continuation handles, possession proofs and content-derived hashes
- **AND** existing detailed user-facing registration errors remain unchanged
- **AND** both the native producer and host projection reject arbitrary labels and invalid numbers independently, using fixed unknown categories or codes rather than exception text
- **AND** exceptional diagnostic property access or emission does not change results, original errors, permission checks, cancellation or cleanup
