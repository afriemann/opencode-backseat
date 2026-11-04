## MODIFIED Requirements

### Requirement: Shared durable coordination store

The plugin SHALL keep coordination state in one selected user data store independently of coordinator and worker project directories.

#### Scenario: Shares an XDG-backed store across projects

- **GIVEN** multiple enabled projects select the same store using absolute `dataDir`, or default `$XDG_DATA_HOME/opencode-backseat` with `~/.local/share/opencode-backseat` when XDG is unset, empty or relative
- **WHEN** coordination starts or a project reloads
- **THEN** participants observe the same durable bindings, observations, consumed limits and unresolved delivery identities rather than separate location-dependent copies.
- **AND** first use initializes an empty store without reading, migrating or deleting existing project-home state; subsequent use preserves populated data.
- **AND** default selection does not discover, read, migrate, delete or fall back to the old branded store; explicit `dataDir` selection and the persisted format remain unchanged.

#### Scenario: Supports trusted writable storage ancestry

- **GIVEN** real root/current-UID-owned ancestor directories with group-write permission, or other-write permission protected by a sticky parent and trusted immediate-child ownership
- **WHEN** coordination initializes, reopens, or acquires shared-store authority
- **THEN** storage and exclusive ownership work without changing ancestor permissions, and reopening preserves durable state.
- **AND** the final store remains current-UID-owned with mode `0700` and its regular single-link files remain current-UID-owned with mode `0600`; identity, no-follow, publication, filesystem and lock checks remain enforced.
- **AND** group/ACL-authorized ancestor writers are trusted: subtree disruption or restoration, rollback and lost lock continuity against those writers are outside this protection boundary.

#### Scenario: Holds unsafe or corrupt shared storage

- **WHEN** a selected path is relative or unsafe, initialized state is missing, corrupt or unreadable, publication is incomplete, or file ownership, private modes, link or filesystem safety cannot be established
- **THEN** coordination stays visibly held without resetting limits, losing uncertain deliveries, repairing existing permissions, following substituted files or falling back to project-local state.
- **AND** shared state and observations have bounded reads and atomic durable publication; only genuinely uninitialized stores start empty.
- **AND** non-sticky other-writable ancestors, untrusted owners, symlinks and observed ancestor substitution remain unsafe.

#### Scenario: Preserves populated stores across manual assignments

- **GIVEN** an existing version-1 store with initial or automatic sends and consumed automation limits
- **WHEN** explicitly approved manual assignments are recorded and the store reloads
- **THEN** existing records and counters remain intact, manual sends retain distinct provenance and delivery identities in the same ledger, and no migration or reset is required.
- **AND** older readers that cannot represent manual sends reject those records rather than silently reinterpret them.

#### Scenario: Rejects invalid manual-delivery records

- **WHEN** a manual record claims automation authority or validation, references an invalid binding, or violates delivery identity bounds
- **THEN** loading rejects the invalid state without dropping records or treating it as an empty store.

### Requirement: Automatic same-service native connection

The coordinator SHALL obtain native inventory through an automatically authenticated connection verified against its current service instance without manual connection configuration or TUI attachment.

#### Scenario: Connects automatically to the current native service

- **GIVEN** a native registration for the service hosting the plugin
- **WHEN** the coordinator requests session inventory
- **THEN** authentication and instance verification occur without user-supplied endpoint or credential settings, and no service is started or restarted.

#### Scenario: Rejects an unavailable or different native service

- **WHEN** native registration is missing, incompatible, or does not identify the hosting service incarnation
- **THEN** inventory reports the specific unavailable or unsupported connection without accepting another service's sessions or changing durable state.

#### Scenario: Rejects unsafe destinations before exposing credentials

- **WHEN** registration safety or destination confinement cannot be established, or a request redirects outside the verified connection
- **THEN** the connection rejects the request without exposing credentials in output, diagnostics, or an unapproved destination.

#### Scenario: Explains initial registration-directory rejection

- **WHEN** initial registration ancestry validation rejects a path because it is not a directory, has a disallowed owner, or has non-sticky other-write permission
- **THEN** the error identifies the first rejected ancestor, the specific condition, and relevant observed type, numeric ownership, or octal permissions with guidance to review the path.
- **AND** diagnostics never reject group-write alone or claim another account actually has access; rejection occurs before opening registration contents and changes no permissions.

#### Scenario: Supports trusted writable registration ancestry

- **GIVEN** real root/current-UID-owned registration ancestors with group-write permission, or other-write permission protected by a sticky parent and trusted immediate-child ownership
- **WHEN** registration is read and its ancestry revalidated
- **THEN** the native connection succeeds without changing permissions while retaining private-file, ownership, no-follow, identity, bounded-read and destination checks.
- **AND** the same trusted-writer boundary as shared storage applies.

#### Scenario: Cancels native reads when the plugin unloads

- **WHEN** the plugin unloads during a native read
- **THEN** the read is cancelled and cannot publish a successful inventory for the disposed instance.
