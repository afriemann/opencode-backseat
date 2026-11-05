## MODIFIED Requirements

### Requirement: Native session inventory

The coordinator SHALL list hierarchical native session metadata with bounded filtering and continuation across projects on its verified service independently of task bindings, storage authority and automation attachment unless a task-dependent query is requested.

#### Scenario: Lists sessions across projects without task or TUI prerequisites

- **GIVEN** native sessions in multiple projects, including sessions without Backseat bindings
- **WHEN** a verified coordinator requests inventory while task storage is unavailable or no TUI is attached
- **THEN** those sessions remain discoverable with identity, title, project, location, agent, parent identity, explicit top-level indicator, archived visibility and current status; native conversation, form, inbox and log contents are not disclosed.

#### Scenario: Reports native running and waiting status without automation evidence

- **WHEN** native activity and pending permission or form state are read for a session without automation observations
- **THEN** running or waiting status reflects those reads, not execution timestamps or missing automation evidence; waiting means pending human input, not ordinary inactivity.

#### Scenario: Reports partial or unknown inventory honestly

- **WHEN** a bounded page is incomplete or native status reads fail or conflict
- **THEN** the response identifies continuation, partial availability and excluded unknown rows instead of implying a complete empty inventory, idle session or completed work.

#### Scenario: Filters hierarchical sessions with multiple statuses

- **WHEN** the caller combines status, project, location, task, agent, title, parent or archived-visibility filters
- **THEN** returned rows satisfy every supplied filter, multiple statuses are alternatives, root selection excludes children, and the default status set excludes only unknown.
- **AND** unsupported or malformed filters fail explicitly rather than being ignored; task-dependent filters fail explicitly when task data is unavailable.

#### Scenario: Excludes subagents by default with explicit hierarchy selection

- **GIVEN** root sessions and child sessions identified by native parent identity
- **WHEN** the caller lists sessions without an explicit parent selector
- **THEN** omitted or false `includeSubagents` returns only roots, while true includes both roots and children, subject to all other filters and before the result limit.
- **AND** explicit `parentID` overrides `includeSubagents`: null selects roots, and a session ID selects its direct children rather than recursive descendants; malformed `includeSubagents` fails explicitly.

#### Scenario: Continues filtered queries without exposing native cursors

- **WHEN** bounded scanning or a result limit leaves more candidates
- **THEN** the response contains a short continuation handle bound to the native service incarnation, caller and original normalized query, without native cursor contents.
- **AND** empty filtered pages can continue; changed filters, a different caller, expired or evicted handles and unloaded instances reject continuation without broadening the query or silently restarting.
- **AND** hierarchy selection remains consistent across buffered and native continuation pages; omitted and false `includeSubagents` are equivalent, while changing its normalized value rejects continuation even with an explicit parent selector.
