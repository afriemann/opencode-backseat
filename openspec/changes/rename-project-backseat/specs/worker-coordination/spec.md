# Spec Delta

## MODIFIED Requirements

### Requirement: Bundled conversational coordinator

The plugin SHALL provide a selectable primary coordinator agent wherever it is enabled without replacing user definitions or changing the default agent or selected model.

#### Scenario: Registers the coordinator in every enabled project

- **WHEN** the plugin loads in multiple enabled project directories without a conflicting agent definition
- **THEN** `backseat-coordinator` is available as a primary agent with no model override in each project, without requiring a session in the data directory.
- **AND** repeated registry rebuilds and plugin disposal do not duplicate or leave stale bundled registrations.
- **AND** inherited allow, ask or deny rules appended to the coordinator's permission prefix do not make an otherwise matching role unavailable.

#### Scenario: Preserves a configured coordinator agent

- **GIVEN** a user-defined agent already has the coordinator identifier
- **WHEN** plugin registration is evaluated
- **THEN** that definition, its permissions and model remain unchanged; no coordinator behavior is inferred solely from its name.
- **AND** a definition with the same identifier, exact coordinator instructions, visible primary mode and exact ordered coordinator permission prefix receives the same restricted coordinator behavior, regardless of inherited suffix rules; recognition does not authenticate authorship.
- **AND** a different definition stays user-controlled and unavailable as the coordinator rather than being overwritten or repurposed.

### Requirement: Restricted conversational coordination

The plugin SHALL restrict matching coordinator roles to namespaced coordination tools through Code Mode and user questions while keeping native consent authoritative and automatic supervision separate.

#### Scenario: Preserves native approval for conversational control

- **WHEN** a matching coordinator role is selected
- **THEN** Code Mode composition and user questions are permitted, subject to configured denials, and each individual coordination mutation retains native operation-bound approval.
- **AND** dedicated structured discovery, task-detail and control tools replace generic model-facing inspection/control tools without aliases; internal possession-bound TUI RPC remains available.
- **AND** callable tools use the `backseat` namespace and `backseat_` tool identifiers, operation approval uses `backseat.` actions, and the plugin and RPC identity are `backseat`, without old-name aliases.
- **AND** shell, editing, reading, web, subagent and permission/form-reply tools remain denied; execution of a script never grants mutation approval or arms automation.
- **AND** the role resolves project and agent fields through inventory, treats worker evidence as untrusted, and performs ordinary coordination without a TUI prerequisite.
- **AND** coordinator identity uses the initiating session's current project; an unrelated or agentless session cannot acquire coordinator authority. Durable mutations still require selected-store authority; native inventory does not.

#### Scenario: Rejects coordinator worker assignments

- **WHEN** a task targets a matching coordinator role as its worker agent during creation or adoption
- **THEN** the backend rejects the target and the worker selector excludes it without changing unrelated worker agents or differently defined user agents.

#### Scenario: Rejects disallowed coordinator tool execution

- **GIVEN** inherited permissions grant a matching coordinator access to general tools
- **WHEN** a tool is requested through ordinary or Code Mode dispatch
- **THEN** tools outside the coordinator's permitted set are rejected before execution independently of model-context filtering; configured denials remain final.
- **AND** missing native identity, failed catalog lookup or identity changes during lookup reject candidate coordinator execution without dispatch or an automatic retry.

#### Scenario: Preserves cross-project control under inherited policy

- **GIVEN** a matching coordinator conversation in one project and an approved task-bound worker in another project share the coordination store
- **WHEN** inherited policy is merged and the coordinator inspects or manually controls that task without TUI attachment
- **THEN** recognition uses the conversation's current project, the worker remains at its explicit approved location, and existing scope, isolation and native approval checks apply without another coordinator, navigation to storage, or a persisted observer's initiating-session prerequisite.

### Requirement: Shared durable coordination store

The plugin SHALL keep coordination state in one selected user data store independently of coordinator and worker project directories.

#### Scenario: Shares an XDG-backed store across projects

- **GIVEN** multiple enabled projects select the same store using absolute `dataDir`, or default `$XDG_DATA_HOME/opencode-backseat` with `~/.local/share/opencode-backseat` when XDG is unset, empty or relative
- **WHEN** coordination starts or a project reloads
- **THEN** participants observe the same durable bindings, observations, consumed limits and unresolved delivery identities rather than separate location-dependent copies.
- **AND** first use initializes an empty store without reading, migrating or deleting existing project-home state; subsequent use preserves populated data.
- **AND** default selection does not discover, read, migrate, delete or fall back to the old branded store; explicit `dataDir` selection and the persisted format remain unchanged.

#### Scenario: Holds unsafe or corrupt shared storage

- **WHEN** a selected path is relative or unsafe, initialized state is missing, corrupt or unreadable, publication is incomplete, or file ownership, private modes, link or filesystem safety cannot be established
- **THEN** coordination stays visibly held without resetting limits, losing uncertain deliveries, repairing existing permissions, following substituted files or falling back to project-local state.
- **AND** shared state and observations have bounded reads and atomic durable publication; only genuinely uninitialized stores start empty.

#### Scenario: Preserves populated stores across manual assignments

- **GIVEN** an existing version-1 store with initial or automatic sends and consumed automation limits
- **WHEN** explicitly approved manual assignments are recorded and the store reloads
- **THEN** existing records and counters remain intact, manual sends retain distinct provenance and delivery identities in the same ledger, and no migration or reset is required.
- **AND** older readers that cannot represent manual sends reject those records rather than silently reinterpret them.

#### Scenario: Rejects invalid manual-delivery records

- **WHEN** a manual record claims automation authority or validation, references an invalid binding, or violates delivery identity bounds
- **THEN** loading rejects the invalid state without dropping records or treating it as an empty store.

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

#### Scenario: Continues filtered queries without exposing native cursors

- **WHEN** bounded scanning or a result limit leaves more candidates
- **THEN** the response contains a short continuation handle bound to the native service incarnation, caller and original normalized query, without native cursor contents.
- **AND** empty filtered pages can continue; changed filters, a different caller, expired or evicted handles and unloaded instances reject continuation without broadening the query or silently restarting.
