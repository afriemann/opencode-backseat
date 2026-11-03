# Spec Delta

## ADDED Requirements

### Requirement: Shared durable coordination store

The plugin SHALL keep coordination state in one selected user data store independently of coordinator and worker project directories.

#### Scenario: Shares an XDG-backed store across projects

- **GIVEN** multiple enabled projects select the same store using absolute `dataDir`, or default `$XDG_DATA_HOME/opencode-conman` with `~/.local/share/opencode-conman` when XDG is unset, empty or relative
- **WHEN** coordination starts or a project reloads
- **THEN** participants observe the same durable bindings, observations, consumed limits and unresolved delivery identities rather than separate location-dependent copies.
- **AND** first use initializes an empty store without reading, migrating or deleting existing project-home state; subsequent use preserves populated data.

#### Scenario: Holds unsafe or corrupt shared storage

- **WHEN** a selected path is relative or unsafe, initialized state is missing, corrupt or unreadable, publication is incomplete, or file ownership, private modes, link or filesystem safety cannot be established
- **THEN** coordination stays visibly held without resetting limits, losing uncertain deliveries, repairing existing permissions, following substituted files or falling back to project-local state.
- **AND** shared state and observations have bounded reads and atomic durable publication; only genuinely uninitialized stores start empty.

### Requirement: Authorised shared-state inspection

The plugin SHALL restrict full coordination state and evidence to verified native coordinator-tool context or current approved native-TUI possession.

#### Scenario: Bootstraps without disclosing task state

- **WHEN** an enabled project requests bootstrap before observer attachment or while ownership is held
- **THEN** the response contains only store identity and availability or held metadata, with no task content, observations, verifier or observer generation.
- **AND** recovery without full-read authority returns metadata rather than a durable task snapshot.

#### Scenario: Rejects unauthorised shared-state reads

- **WHEN** full state or evidence is requested with an unrelated role, caller-supplied identity alone, obsolete proof, wrong store, relocated initiating session or revoked attachment
- **THEN** no task snapshot or evidence is disclosed.
- **AND** verified coordinator-tool calls and currently approved native-TUI proofs can inspect the selected store without granting worker evidence any control authority.

## MODIFIED Requirements

### Requirement: Exclusive coordinator authority

The coordinator SHALL allow mutations only through the active authority for the single canonical data store selected by its local service.

#### Scenario: Holds a competing or unsafe authority

- **WHEN** a project selects a store conflicting with the service's first active store, another process owns the store, the runtime path is unsafe, or required host capabilities including the trusted lock helper are unavailable
- **THEN** the new participant remains visibly read-only held and performs no worker dispatch or ownership mutation.
- **AND** projects selecting the same store share one serialized authority, including concurrent mutation and observation publication, rather than acquiring independent state caches.

#### Scenario: Requires explicit stale-owner recovery

- **GIVEN** an authority stopped without releasing its ownership
- **WHEN** coordination restarts
- **THEN** ownership is not automatically expired or removed, and automation remains held until prior-owner termination is confirmed, recovery is authorised and coordination is separately rearmed.

#### Scenario: Fences an unloaded project without releasing other participants

- **GIVEN** multiple enabled projects share the active store
- **WHEN** one project unloads or the final participant closes
- **THEN** the unloaded project's pending operations, asks, evaluations, observations and initiating attachment cannot admit further work, while other participants retain shared ownership until final shutdown safely drains publication and releases it.
- **AND** replacement acquisition cannot overlap closing ownership; reconnect still requires fresh approval and reconciliation, preserving uncertain deliveries and consumed limits.

### Requirement: Approved observer generation

The coordinator SHALL authorise native observer mutations only through explicit operation-bound approval of the current observer generation.

#### Scenario: Native approval binds observer generation

- **GIVEN** the selected native TUI requests attachment from an eligible dedicated coordinator session in an enabled project
- **WHEN** a genuine native approval decision approves that observer's verifier and generation
- **THEN** only possession proofs bound to the selected store, actual initiating session and location, exact target, generation and authorised operation can mutate coordination state; an allow policy alone does not replace the explicit ask.
- **AND** role, location, store and target are revalidated after approval; native session, agent, permission and worker APIs never use the data directory as a project destination.

#### Scenario: Rejects unapproved observer mutations

- **WHEN** a request supplies only a confirmation claim, invalid possession proof, replayed operation, obsolete generation or configured denial, or its approved session, location, store, role or target changes
- **THEN** no scope, ownership, limit, dispatch intent or completion state is changed; denied replacement attachment preserves the incumbent generation, while failed durable publication is visibly held rather than reported committed.

### Requirement: Bundled conversational coordinator

The plugin SHALL provide a selectable primary coordinator agent wherever it is enabled without replacing user definitions or changing the default agent or selected model.

#### Scenario: Registers the coordinator in every enabled project

- **WHEN** the plugin loads in multiple enabled project directories without a conflicting agent definition
- **THEN** `conman-coordinator` is available as a primary agent with no model override in each project, without requiring a session in the data directory.
- **AND** repeated registry rebuilds and plugin disposal do not duplicate or leave stale bundled registrations.

#### Scenario: Preserves a configured coordinator agent

- **GIVEN** a user-defined agent already has the coordinator identifier
- **WHEN** plugin registration is evaluated
- **THEN** that definition, its permissions and model remain unchanged; no bundled privileges or worker-role restrictions are inferred solely from its name.
- **AND** the conflicting user definition cannot act as the bundled coordinator; coordination reports the unavailable dedicated role instead of reusing it.

### Requirement: Restricted conversational coordination

The plugin SHALL restrict the bundled coordinator to coordination tools and user questions while keeping native consent and connected-TUI supervision authoritative.

#### Scenario: Preserves native approval for conversational control

- **WHEN** the bundled coordinator is selected
- **THEN** only `conman_inspect`, `conman_control` and user questions are allowed, with native `conman.*` actions requiring approval rather than inheriting permissive agent defaults.
- **AND** shell, editing, reading, web, Code Mode, subagent and permission/form-reply capabilities remain denied; attachment and supervision are not automatically approved or armed.
- **AND** the role requests unknown project and agent fields, treats worker evidence as untrusted, and directs operations requiring native reconciliation to the TUI rather than inventing authority or retrying uncertain results.
- **AND** coordinator operations require the actual bundled role resolved at the initiating session's current project for the selected store; an unrelated assigned agent or an agentless session cannot acquire coordinator authority.

#### Scenario: Rejects coordinator worker assignments

- **WHEN** a task targets the actual bundled coordinator role as its worker agent during creation or adoption
- **THEN** the backend rejects the target and the worker selector excludes it without changing unrelated worker agents or user-defined collisions.
