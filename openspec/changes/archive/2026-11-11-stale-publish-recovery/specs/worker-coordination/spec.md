## MODIFIED Requirements

### Requirement: Shared durable coordination store

The plugin SHALL persist followers and native delivery identities independently of project directories in its selected shared data store.

#### Scenario: Shares an XDG-backed store across projects

- **WHEN** enabled projects select the same absolute dataDir or default XDG-backed opencode-backseat store
- **THEN** they share following and delivery state, with no project-local fallback or task migration.

#### Scenario: Supports trusted writable storage ancestry

- **WHEN** storage ancestry satisfies the existing trusted-owner and sticky-parent boundary
- **THEN** storage works without changing ancestor permissions and retains private final-directory and file modes, no-follow and atomic publication checks.

#### Scenario: Holds unsafe or corrupt shared storage

- **WHEN** state is unsafe, corrupt, unreadable or incompatible with the session-centric format
- **THEN** mutations fail explicitly without overwriting existing state, resetting it or migrating task records.

#### Scenario: Recovers from an interrupted publication

- **WHEN** a writable store contains a leftover temporary publication file that is a private regular single-link file owned by the user
- **THEN** the file is removed and the existing state is loaded unchanged.

#### Scenario: Holds on an unexpected store entry

- **WHEN** a store contains an entry that is not a store file or a safe leftover publication file
- **THEN** storage is held and the entry is not removed.

#### Scenario: Recovers a held coordinator once storage is safe

- **WHEN** a coordination tool is called after startup held the coordinator and the store has since become safe and unowned
- **THEN** the call acquires authority, starts following and succeeds without restarting the service.

#### Scenario: Preserves populated stores across manual assignments

- **WHEN** a session-centric store is reloaded after session control
- **THEN** its followers, pending notifications and unresolved native deliveries remain intact.

#### Scenario: Rejects invalid manual-delivery records

- **WHEN** persisted delivery identities are malformed or exceed retention bounds
- **THEN** state loading fails without silently dropping records.
