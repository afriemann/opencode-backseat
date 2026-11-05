# worker-coordination Specification

## Purpose

Bind approved tasks to explicitly selected local OpenCode workers so a single coordinator can manage parallel work without confusing locations or ownership.

## Requirements

### Requirement: Approved task binding

The coordinator SHALL bind each task to an explicitly authorised goal, success criteria, constraints, scope, project location and worker agent before starting work.

#### Scenario: Creates a worker at the selected location

- **GIVEN** an authorised task and an agent available at its selected location
- **WHEN** the coordinator creates its worker through conversational control without TUI attachment
- **THEN** the new session uses that location and agent and receives only the task's authorised starting prompt, without a separate resume or automation-arming step.

#### Scenario: Rejects an unavailable or mismatched target

- **WHEN** a requested location is missing, its agent is unavailable, or a task lacks an authorised binding
- **THEN** no worker is started and the coordinator reports the unresolved target without substituting another project or agent.

### Requirement: Explicit adoption

The coordinator SHALL require explicit adoption of an existing worker into one active task ownership binding.

#### Scenario: Adopts the selected existing worker

- **GIVEN** an existing session, its location, agent and approved task are explicitly selected
- **WHEN** adoption is authorised
- **THEN** the coordinator binds that session without silently changing its agent or treating unrelated history as shared task context.

#### Scenario: Rejects competing ownership

- **WHEN** adoption would assign a session already owned by another active task or coordinator
- **THEN** adoption is rejected until the previous ownership is explicitly released.

### Requirement: Explicit control transitions

The coordinator SHALL apply hold, resume and takeover only to their explicitly targeted task ownership state.

#### Scenario: Takeover invalidates automatic follow-ups

- **GIVEN** a worker has a pending supervision decision
- **WHEN** its user takes over or holds the task
- **THEN** automatic dispatch is disabled and that decision becomes invalid without affecting other tasks.

#### Scenario: Resume requires fresh eligible state

- **GIVEN** a held or manually owned task
- **WHEN** its user explicitly resumes coordination
- **THEN** ownership is re-established only after current operation-bound native TUI reconciliation of the target, asks, observation and approval; incomplete or changed eligibility stays held and obsolete decisions are not dispatched.

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

### Requirement: Fine-grained coordination catalogs

The plugin SHALL provide dedicated structured project, agent, task-list and task-detail tools instead of generic view or operation multiplexers.

#### Scenario: Lists catalogs and retrieves task details independently

- **WHEN** the coordinator requests project locations, eligible agents, filtered task summaries or one task's details
- **THEN** each tool accepts its own explicit arguments and returns its requested structured result, preserving task-read authority and isolating task histories, delivery identities, completion evidence and retained deletion diagnostics with current native presence evidence.

### Requirement: Top-level session ownership

The coordinator SHALL restrict adoption and takeover to native top-level sessions independently of selection filters and model instructions.

#### Scenario: Rejects child adoption and takeover before and after approval

- **WHEN** an adoption or takeover targets a child session or its top-level identity changes while approval is pending
- **THEN** no ownership mutation or prompt occurs, while an explicitly approved unchanged top-level session remains eligible.

### Requirement: Explicit native subtree deletion

The coordinator SHALL require operation-bound native approval before deleting a session's native subtree while preserving coordination history and all delivery identities.

#### Scenario: Deletes the approved native subtree and preserves task history

- **WHEN** an eligible coordinator explicitly approves deletion of a selected session and its native subtree, including execution interruption and concurrent descendants
- **THEN** the native removal is invoked once, discovered affected automatic tasks are fenced durably, and all task history, counters and delivery identities remain intact; no atomic pre-enumerated-set guarantee is implied.

#### Scenario: Rejects unsafe deletion and retains uncertain outcomes

- **WHEN** approval is denied, the root or caller changes, ancestry is incomplete or cyclic, the root contains the invoking coordinator, a collected subtree overlaps a retained deletion, or a deletion acknowledgement is uncertain
- **THEN** unsafe deletion is not admitted, and any potentially admitted deletion remains durably identifiable and is not silently retried after reload; observed native absence does not convert an uncertain deletion into success or prove outstanding work was never delivered.

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
