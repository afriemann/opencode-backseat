# Spec Delta

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
- **THEN** the unloaded project's pending operations, asks, evaluations, observations and initiating coordinator authority cannot admit further work, while other participants retain shared ownership until final shutdown safely drains publication and releases it.
- **AND** replacement acquisition cannot overlap closing ownership; reconnect still requires fresh approval and reconciliation, preserving uncertain deliveries and consumed limits.

### Requirement: Explicit control transitions

The coordinator SHALL apply hold, resume and takeover only to their explicitly targeted task ownership state.

#### Scenario: Takeover invalidates automatic follow-ups

- **GIVEN** a worker has a pending supervision decision
- **WHEN** its user takes over or holds the task
- **THEN** automatic dispatch is disabled and that decision becomes invalid without affecting other tasks.

#### Scenario: Resume requires fresh eligible state

- **GIVEN** a held or manually owned task
- **WHEN** its user explicitly resumes coordination through the agent
- **THEN** ownership is re-established only after current operation-bound native approval and server reconciliation of the target, asks and observation; incomplete or changed eligibility stays held and obsolete decisions are not dispatched.
- **AND** successful rearming schedules the already-settled target without requiring another idle event; inactive historical bindings do not require fresh observations, other active evaluations remain queued, and failed rearming is reported without leaving a falsely active target.

### Requirement: Approved observer generation

The coordinator SHALL authorise server supervision generations through explicit operation-bound native approval requested by the current coordinator agent.

#### Scenario: Native approval binds observer generation

- **GIVEN** an eligible dedicated coordinator session in an enabled project requests supervision start or resume
- **WHEN** a genuine native approval decision approves the selected generation and targets
- **THEN** the server binds authority to the selected store, actual initiating session and location, exact targets and generation; an allow policy alone does not replace the explicit ask.
- **AND** role, location, store and targets are revalidated after approval; native session, agent, permission and worker APIs never use the data directory as a project destination.

#### Scenario: Rejects unapproved observer mutations

- **WHEN** a request supplies only a confirmation claim, obsolete generation or configured denial, or its approved session, location, store, role or target changes
- **THEN** no scope, ownership, limit, dispatch intent or completion state is changed; denied replacement approval preserves the incumbent generation, while failed durable publication is visibly held rather than reported committed.
- **AND** terminal attachment and possession proofs are neither required nor accepted as alternative mutation authority.

### Requirement: Restricted conversational coordination

The plugin SHALL restrict matching coordinator roles to namespaced coordination tools through Code Mode and user questions while keeping native consent authoritative and automatic supervision separate.

#### Scenario: Preserves native approval for conversational control

- **WHEN** a matching coordinator role is selected
- **THEN** Code Mode composition and user questions are permitted, subject to configured denials, and each individual coordination mutation retains native operation-bound approval.
- **AND** dedicated structured discovery, content and control tools replace generic model-facing inspection/control tools without aliases; no terminal control interface is registered.
- **AND** callable tools use the `backseat` namespace and `backseat_` tool identifiers, operation approval uses `backseat.` actions, and the plugin and RPC identity are `backseat`, without old-name aliases.
- **AND** direct shell, editing, reading, web, subagent and raw permission/form-reply tools remain denied; approved Backseat session-control wrappers are permitted, and execution of a script never grants mutation approval or arms automation.
- **AND** the role resolves project and agent fields through inventory, treats worker evidence as untrusted, and performs ordinary coordination without a TUI prerequisite.
- **AND** coordinator identity uses the initiating session's current project; an unrelated or agentless session cannot acquire coordinator authority. Durable mutations still require selected-store authority; native inventory does not.

#### Scenario: Rejects coordinator worker assignments

- **WHEN** a task targets a matching coordinator role as its worker agent during creation or adoption
- **THEN** the backend rejects the target and eligible-agent discovery excludes it without changing unrelated worker agents or differently defined user agents.

#### Scenario: Rejects disallowed coordinator tool execution

- **GIVEN** inherited permissions grant a matching coordinator access to general tools
- **WHEN** a tool is requested through ordinary or Code Mode dispatch
- **THEN** tools outside the coordinator's permitted set are rejected before execution independently of model-context filtering; configured denials remain final.
- **AND** missing native identity, failed catalog lookup or identity changes during lookup reject candidate coordinator execution without dispatch or an automatic retry.

#### Scenario: Preserves cross-project control under inherited policy

- **GIVEN** a matching coordinator conversation in one project and a selected worker in another project share the coordination store
- **WHEN** inherited policy is merged and the coordinator inspects or manually controls that worker without TUI attachment
- **THEN** recognition uses the conversation's current project, the worker remains at its explicit approved location, and applicable scope, isolation and native approval checks apply without another coordinator, navigation to storage, or a persisted observer's initiating-session prerequisite.

### Requirement: Shared durable coordination store

The plugin SHALL keep coordination state in one selected user data store independently of coordinator and worker project directories.

#### Scenario: Shares an XDG-backed store across projects

- **GIVEN** multiple enabled projects select the same store using absolute `dataDir`, or default `$XDG_DATA_HOME/opencode-backseat` with `~/.local/share/opencode-backseat` when XDG is unset, empty or relative
- **WHEN** coordination starts or a project reloads
- **THEN** participants observe the same durable bindings, observations, consumed limits and unresolved delivery identities rather than separate location-dependent copies.
- **AND** first use initializes an empty store without reading, migrating or deleting existing project-home state; subsequent use preserves populated data.
- **AND** default selection does not discover, read, migrate, delete or fall back to the old branded store; explicit `dataDir` selection and existing task records remain compatible while session-delivery extensions are decoded explicitly.

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
- **THEN** existing records and counters remain intact and manual sends retain distinct provenance and delivery identities without destructive migration or reset.
- **AND** older readers that cannot represent the extended state reject it rather than silently reinterpret it.

#### Scenario: Rejects invalid manual-delivery records

- **WHEN** a manual record claims automation authority or validation, references an invalid binding, or violates delivery identity bounds
- **THEN** loading rejects the invalid state without dropping records or treating it as an empty store.

### Requirement: Authorised shared-state inspection

The plugin SHALL restrict full coordination state and evidence to verified native coordinator-tool context.

#### Scenario: Bootstraps without disclosing task state

- **WHEN** an enabled project requests bootstrap without verified coordinator-tool identity or while ownership is held
- **THEN** the response contains only store identity and availability or held metadata, with no task content, observations or observer generation.
- **AND** recovery without full-read authority returns metadata rather than a durable task snapshot.

#### Scenario: Rejects unauthorised shared-state reads

- **WHEN** full state or evidence is requested with an unrelated role, caller-supplied identity alone, obsolete terminal proof, wrong store or relocated initiating session
- **THEN** no task snapshot or evidence is disclosed.
- **AND** verified coordinator-tool calls can inspect the selected store without granting worker evidence any control authority.

### Requirement: Conversational manual assignment

The coordinator SHALL admit explicitly requested assignments to selected existing sessions through operation-bound native approval without task binding, observer attachment, resume, or automation arming.

#### Scenario: Takes over a selected session without inventing work

- **WHEN** the user selects an existing session for coordinator management without requesting an assignment
- **THEN** the coordinator takes over an existing binding when present, fences automatic decisions, and sends no invented prompt, agent switch, or interruption; a session without a binding requires no fabricated task.

#### Scenario: Sends repeated assignments without automation prerequisites

- **GIVEN** a selected session with no task binding or a held or manually managed binding
- **WHEN** the user requests successive assignments and each receives native approval
- **THEN** each assignment reaches the selected worker without resume or arming, does not consume automation allowances, and leaves affected automatic dispatch disabled; bound assignments remain within their approved task scope.

#### Scenario: Rejects changed or unapproved manual targets

- **WHEN** native approval is denied, the initiating identity or selected target changes during approval, competing ownership remains, or a bound assignment's declared scope exceeds approved scope
- **THEN** no manual prompt is admitted and the concrete unresolved target or permission is reported without implicitly answering pending native asks.

#### Scenario: Retains an uncertain manual send without resending

- **WHEN** admission acknowledgement is lost or durable publication fails after a manual send may have been accepted, including a send without task binding
- **THEN** its reserved delivery identity survives reload, further sends remain blocked pending reconciliation, and no automatic resend or replacement identity is generated.

## ADDED Requirements

### Requirement: Native session content pagination

The coordinator SHALL retrieve bounded native session history and activity independently of task binding through dedicated content tools on its verified service.

#### Scenario: Pages selected session content incrementally

- **WHEN** a verified coordinator requests selected-session messages, one message, context, diff, queued input, pending requests, saved permissions, instructions, statistics or export content
- **THEN** the result identifies its target and requested projection, bounded content, truncation or continuation, and availability without fetching unrelated sessions or silently claiming completeness.
- **AND** message order and type remain consistent across pages; continuation handles bind caller, service incarnation, target and normalized query and have finite lifetime and capacity.

#### Scenario: Rejects invalid or unavailable content continuation

- **WHEN** the target is missing, a native read fails, or a continuation is expired, evicted, from another caller/service/target or combined with changed query arguments
- **THEN** the tool reports the concrete unavailable or invalid continuation without silently restarting or broadening the read, returning unrelated content, or changing durable state.

### Requirement: Since-send response tracking

The coordinator SHALL return a send reference usable for bounded incremental observation of subsequent activity, distinguishing correlation from uncertain attribution.

#### Scenario: Follows activity from an admitted send

- **GIVEN** an admitted coordinator send and its returned reference
- **WHEN** the coordinator polls activity from that reference or a returned continuation while a response is ongoing
- **THEN** results expose subsequent durable activity and updated unfinished-message content with an exclusive progress checkpoint rather than repeatedly returning full history.
- **AND** queued admission is not represented as a delivered response; concurrent unrelated activity is not falsely labelled causally attributable to the send.

#### Scenario: Reports tracking discontinuity honestly

- **WHEN** an anchor is missing, history changed through compaction or revert, or tracking state is expired, unavailable or belongs to a different target/service/caller
- **THEN** the result identifies discontinuity or invalid tracking rather than silently skipping content, inventing attribution or resending the original prompt.

### Requirement: Full native session controls

The coordinator SHALL expose dedicated typed tools for native session operations supported by the pinned host, using selected-session identity and operation-bound native approval for mutations rather than a generic API passthrough.

#### Scenario: Executes approved native session operations

- **WHEN** the coordinator requests creation, fork, import, title/metadata/archive update, move, agent/model selection, prompt with attachments, synthetic input, command, shell execution, skill activation, generation, compaction, revert staging/clearing/commit, interruption, backgrounding, waiting, view, inbox cancellation/delivery update, form creation/cancellation, instruction changes or environment replacement
- **THEN** the dedicated operation uses its typed native contract, explicit target and requested arguments, revalidates identity and target after native approval when mutating, returns the native outcome without claiming completion from admission, and needs no task binding.
- **AND** applicable shared-store authority, competing-owner checks and uncertain-send reconciliation remain enforced; affected automatic decisions are fenced before manual mutation, without widening task scope or automatically rearming supervision.

#### Scenario: Rejects denied stale or unsupported controls

- **WHEN** native approval is denied, the caller or target changes, selected project/agent/model is unavailable, the operation is unsupported, or native acknowledgement is uncertain
- **THEN** the tool reports denial, unavailability or uncertainty without a substitute target, broader raw API access, duplicate execution or silent retry; potentially admitted sends retain their reserved identities.

### Requirement: Explicit native request replies

The coordinator SHALL answer native permission and form requests only through explicit operation-bound human approval of the selected request and reply payload.

#### Scenario: Replies to the selected native request

- **WHEN** the user approves an agent-requested permission decision or typed form answer for a current selected worker request
- **THEN** the matching native reply API receives exactly that decision or answer after target, request and payload revalidation; pending worker input and worker claims alone grant no approval.
- **AND** permission request creation and saved-permission removal require their own explicit operation approvals rather than inheriting authority from a reply.

#### Scenario: Rejects a changed or unapproved reply

- **WHEN** approval is denied, the request resolves or changes while approval is pending, the target changes, or autonomous supervision attempts a reply
- **THEN** no reply or policy change is issued and the outcome identifies the unresolved approval or stale request without guessing an answer or translating it into a consent prompt.

### Requirement: Hierarchical session control

The coordinator SHALL permit explicit control and adoption of selected child sessions under the same applicable authority checks as root sessions.

#### Scenario: Adopts a selected child without widening ownership

- **WHEN** a user approves adoption or takeover of an unchanged selected child session without competing ownership
- **THEN** that child is eligible without top-level-only rejection and no authority over its parent or siblings is inferred.

#### Scenario: Rejects changed hierarchical targets

- **WHEN** child identity, location, agent, ancestry or ownership relevant to the approved action changes during approval
- **THEN** the action is rejected rather than retargeting its parent, siblings or another session.

### Requirement: Compatible session-delivery persistence

The coordinator SHALL preserve populated coordination stores and unresolved session deliveries when adding task-independent native interaction.

#### Scenario: Reloads task-free delivery state without resetting tasks

- **GIVEN** populated task records, consumed limits and a task-free send whose admission is uncertain
- **WHEN** state is published and reloaded
- **THEN** all existing records, counters and delivery identities remain intact and reconciliation uses the original session send identity without creating a task or duplicate delivery.
- **AND** an uncertain create/import may be resolved against the unchanged existing native identity through separate native approval, without repeating creation or claiming unverified imported content matches.
- **AND** a persisted retirement cutoff and verified initiating-message identities survive reload; existing records without such proof remain non-retirable.

#### Scenario: Rejects incompatible delivery records without reset

- **WHEN** a stored session-delivery record is corrupt, exceeds retention bounds or cannot be represented by the reader
- **THEN** coordination holds without dropping unresolved identities, reinterpreting them as automated sends or resetting the store.

#### Scenario: Retires confirmed deliveries without replaying expired invocations

- **WHEN** the bounded ledger is full and a new native invocation has verified coordinator-message identity and creation time
- **THEN** only admitted records with verified initiating-message proof may retire, oldest first, atomically advancing a non-decreasing expiry cutoff; absent invocations at or below that cutoff, including ties, are rejected without effects.
- **AND** reserved, ambiguous and legacy-unproven identities are preserved; an exhausted pinned ledger or unverifiable new invocation holds admission rather than resetting state, retrying an effect or forgetting an unresolved identity.

## REMOVED Requirements

### Requirement: Top-level session ownership

**Reason**: Explicit child-session control is part of native session coordination.
**Migration**: Select and approve the child directly using the same operation-bound native authority as a root session.
