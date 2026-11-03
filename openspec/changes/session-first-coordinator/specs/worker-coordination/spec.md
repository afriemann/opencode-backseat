## ADDED Requirements

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

#### Scenario: Cancels native reads when the plugin unloads

- **WHEN** the plugin unloads during a native read
- **THEN** the read is cancelled and cannot publish a successful inventory for the disposed instance.

### Requirement: Native session inventory

The coordinator SHALL list native sessions across all projects on its verified service independently of task bindings, storage authority, and automation attachment.

#### Scenario: Lists sessions across projects without task or TUI prerequisites

- **GIVEN** native sessions in multiple projects, including sessions without Conman bindings
- **WHEN** a verified coordinator requests inventory while task storage is unavailable or no TUI is attached
- **THEN** those sessions remain discoverable with identity, title, project location, agent, and current status metadata; protected task content and native conversation, form, inbox, and log contents are not disclosed.

#### Scenario: Reports native running and waiting status without automation evidence

- **WHEN** native activity and pending permission or form state are read for a session without automation observations
- **THEN** running or waiting-for-input status reflects those native reads, not execution timestamps or missing automation evidence.

#### Scenario: Reports partial or unknown inventory honestly

- **WHEN** a bounded inventory page is incomplete or a native status read fails or conflicts
- **THEN** the response identifies continuation or partial availability and unknown status rather than claiming an empty inventory, idle session, or completed work.

### Requirement: Conversational manual assignment

The coordinator SHALL admit explicitly requested assignments to selected existing sessions through operation-bound native approval without observer attachment, resume, or automation arming.

#### Scenario: Takes over a selected session without inventing work

- **WHEN** the user selects an existing session for coordinator management without requesting an assignment
- **THEN** the coordinator adopts its binding or takes over its existing binding, fences automatic decisions, and sends no invented prompt, agent switch, or interruption.

#### Scenario: Sends repeated assignments without automation prerequisites

- **GIVEN** a selected held or manually managed binding with no observer attachment
- **WHEN** the user requests successive assignments within its approved scope and each receives native approval
- **THEN** each assignment reaches the selected worker without resume or arming, does not consume automation allowances, and leaves automatic dispatch disabled.

#### Scenario: Rejects changed or unapproved manual targets

- **WHEN** native approval is denied, the initiating identity or selected binding changes during approval, competing ownership remains, or the assignment's declared scope exceeds approved scope
- **THEN** no manual prompt is admitted and the concrete unresolved target or permission is reported without implicitly answering pending native asks.

#### Scenario: Retains an uncertain manual send without resending

- **WHEN** admission acknowledgement is lost or durable publication fails after a manual send may have been accepted
- **THEN** its reserved delivery identity survives reload, further sends remain blocked pending reconciliation, and no automatic resend or replacement identity is generated.

## MODIFIED Requirements

### Requirement: Approved task binding

The coordinator SHALL bind each task to an explicitly authorised goal, success criteria, constraints, scope, project location and worker agent before starting work.

#### Scenario: Creates a worker at the selected location

- **GIVEN** an authorised task and an agent available at its selected location
- **WHEN** the coordinator creates its worker through conversational control without TUI attachment
- **THEN** the new session uses that location and agent and receives only the task's authorised starting prompt, without a separate resume or automation-arming step.

#### Scenario: Rejects an unavailable or mismatched target

- **WHEN** a requested location is missing, its agent is unavailable, or a task lacks an authorised binding
- **THEN** no worker is started and the coordinator reports the unresolved target without substituting another project or agent.

### Requirement: Restricted conversational coordination

The plugin SHALL restrict matching coordinator roles to coordination tools and user questions while keeping native consent authoritative and automatic supervision separate from conversational commands.

#### Scenario: Preserves native approval for conversational control

- **WHEN** a matching coordinator role is selected
- **THEN** only `conman_inspect`, `conman_control` and user questions are permitted, subject to configured denials, with native `conman.*` actions requiring approval rather than inheriting permissive agent defaults.
- **AND** shell, editing, reading, web, Code Mode, subagent and permission/form-reply capabilities remain denied; attachment and supervision are not automatically approved or armed.
- **AND** the role resolves project and agent fields through inventory, asks only when the user's selection remains ambiguous, treats worker evidence as untrusted, and performs ordinary listing, takeover, creation and assignment without directing the user to a TUI.
- **AND** coordinator operations require matching role semantics resolved at the initiating session's current project; an unrelated assigned agent or an agentless session cannot acquire coordinator authority. Durable mutations still require authority for the selected store; native inventory does not.

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

- **GIVEN** multiple enabled projects select the same store using absolute `dataDir`, or default `$XDG_DATA_HOME/opencode-conman` with `~/.local/share/opencode-conman` when XDG is unset, empty or relative
- **WHEN** coordination starts or a project reloads
- **THEN** participants observe the same durable bindings, observations, consumed limits and unresolved delivery identities rather than separate location-dependent copies.
- **AND** first use initializes an empty store without reading, migrating or deleting existing project-home state; subsequent use preserves populated data.

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
