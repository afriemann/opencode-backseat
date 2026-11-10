## MODIFIED Requirements

### Requirement: Native session inventory

The coordinator SHALL list hierarchical native session metadata with bounded filtering and continuation across projects independently of follower storage availability.

#### Scenario: Lists sessions across projects without task or TUI prerequisites

- **WHEN** verified inventory is requested while follower storage is unavailable
- **THEN** native sessions remain discoverable with identity, title, project, location, agent, parent, archived visibility and status without disclosing conversation content.

#### Scenario: Reports native running and waiting status without automation evidence

- **WHEN** native activity and pending permission or form state are read
- **THEN** running and waiting status reflects those reads rather than missing automation evidence.

#### Scenario: Reports partial or unknown inventory honestly

- **WHEN** scanning is incomplete or native status reads fail
- **THEN** continuation, partial availability and unknown status are explicit rather than implying empty inventory or completion.

#### Scenario: Filters hierarchical sessions with multiple statuses

- **WHEN** supported status, project, location, agent, title, parent or archived filters are combined
- **THEN** every supplied filter applies and unsupported filters, including removed task filters, fail explicitly.

#### Scenario: Excludes subagents by default with explicit hierarchy selection

- **WHEN** inventory omits a parent selector
- **THEN** includeSubagents defaults false; explicit parentID selects roots or direct children and overrides includeSubagents.

#### Scenario: Continues filtered queries without exposing native cursors

- **WHEN** more candidates remain
- **THEN** a bounded handle binds the caller, service and normalized query; changed, expired or foreign continuations fail without restarting.

#### Scenario: Bounds candidate reads before status hydration

- **WHEN** inventory has a result limit and metadata filters
- **THEN** native candidate reads respect that limit and mismatches avoid status hydration, permitting short pages with continuation.

#### Scenario: Shares pending form reads within each inventory refresh

- **WHEN** sessions share a location
- **THEN** one location-wide pending-form read serves that refresh and subsequent calls obtain fresh state.

#### Scenario: Filters by update and creation time

- **WHEN** updatedBefore, updatedAfter, createdBefore or createdAfter is given as ISO-8601 with a Z or offset, or Unix milliseconds
- **THEN** only sessions inside every bound are returned, Before bounds being exclusive and After bounds inclusive, and mismatched sessions are not status-hydrated.
- **AND** any other value fails explicitly.

#### Scenario: Stops scanning once no later session can match

- **WHEN** order is descending with updatedAfter, or ascending with updatedBefore, and a scanned session already falls outside the bound
- **THEN** scanning stops and no continuation is offered for the remainder.

#### Scenario: Filters by project subpath

- **WHEN** subpath is given with projectID
- **THEN** only sessions at that exact path relative to the project root are returned and the subpath binds continuations.
- **AND** subpath without projectID fails explicitly.

#### Scenario: Lists metadata without status hydration

- **WHEN** hydrate is false
- **THEN** rows carry metadata with status unknown and no status reads occur.
- **AND** combining hydrate false with statuses fails explicitly, and a continuation cannot be reused with a different hydrate value.

#### Scenario: Defers rows when the hydration budget is spent

- **WHEN** status hydration exceeds its time budget
- **THEN** at least one batch is hydrated, the remaining rows stay in the continuation, and the result is partial rather than failing or reporting unhydrated rows as unknown.

## ADDED Requirements

### Requirement: Retryable native failures

The coordinator SHALL report a native read failure with a fixed safe cause and SHALL keep stored continuations usable after a timeout or cancellation.

#### Scenario: Reports a timeout distinctly

- **WHEN** a native read exceeds its deadline
- **THEN** the error states the read timed out, and never includes URLs, headers or registration contents.

#### Scenario: Retries a continuation after a timeout

- **GIVEN** a continuation and a native read that timed out or was cancelled
- **WHEN** the same continuation is requested again before it expires
- **THEN** the listing resumes from it without a restart and its expiry is unchanged.

#### Scenario: Discards continuations after disposal or identity failure

- **WHEN** the plugin is disposed, or registration or identity validation fails
- **THEN** stored continuations are discarded and later use fails with a restart-listing message.
