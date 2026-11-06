# Spec Delta

## REMOVED Requirements

### Requirement: Approved task binding

**Reason**: Session control does not require tasks.
**Migration**: Create or adopt a selected session directly.

### Requirement: Explicit control transitions

**Reason**: Task hold, resume and automation ownership are removed.
**Migration**: Start following through adoption and stop following explicitly.

### Requirement: Approved observer generation

**Reason**: Following starts without a supervision generation.
**Migration**: Use session adoption directly.

### Requirement: Fine-grained coordination catalogs

**Reason**: Task catalogs disappear with task bindings.
**Migration**: Use native project, agent and session catalogs.

## MODIFIED Requirements

### Requirement: Explicit adoption

The coordinator SHALL immediately follow an explicitly selected existing native session without requiring initial input or a task.

#### Scenario: Adopts the selected existing worker

- **WHEN** a coordinator adopts a selected session
- **THEN** following binds that exact session and location to the initiating coordinator without changing its agent or sending input.

#### Scenario: Accepts task-free adoption without inventing a binding

- **WHEN** a root or child session is adopted without a task
- **THEN** background following starts without a send, criteria, observer snapshot, supervision start or resume step.
- **AND** existing pending permission and form requests are surfaced to the coordinator.

#### Scenario: Rejects competing ownership

- **WHEN** another coordinator already follows the selected session
- **THEN** adoption reports the conflict without taking over that follower.

#### Scenario: Rejects stale or denied task-free adoption

- **WHEN** configured permissions deny adoption or the selected native session is unavailable
- **THEN** no follower is created and no substitute target or initial message is used.

### Requirement: Exclusive coordinator authority

The coordinator SHALL serialize mutations through one local authority for its selected durable store.

#### Scenario: Holds a competing or unsafe authority

- **WHEN** store ownership cannot be acquired or storage is unsafe
- **THEN** mutations report unavailable authority while native inventory remains accessible.
- **AND** projects selecting the same store share serialized publication.

#### Scenario: Reacquires terminated ownership without arming supervision

- **WHEN** a reload acquires the store's exclusive lock
- **THEN** saved followers resume observation without supervision approval, preserving unresolved delivery identities.

#### Scenario: Revalidates terminated ownership under exclusive acquisition

- **WHEN** competing processes attempt to acquire the store
- **THEN** only the exclusive lock holder publishes state and lock files are not deleted to bypass exclusion.

#### Scenario: Fences an unloaded project without releasing other participants

- **WHEN** a project unloads
- **THEN** its in-flight operations are cancelled without releasing another participant's store authority or killing workers.
- **AND** saved followers remain available for automatic replay on reload.

### Requirement: Restricted conversational coordination

The plugin SHALL restrict matching coordinator roles to Backseat tools through Code Mode and user questions, subject to configured OpenCode permissions.

#### Scenario: Preserves native approval for conversational control

- **WHEN** a matching coordinator invokes a native control
- **THEN** configured allow proceeds without a forced Backseat ask, configured ask requests approval and configured deny rejects the operation.
- **AND** the `backseat` namespace, `backseat_` tool identifiers and `backseat.` permission actions remain consistent, without aliases or terminal UI.
- **AND** worker content is evidence, not a user instruction; the coordinator can still judge actions and worker request replies.

#### Scenario: Rejects coordinator worker assignments

- **WHEN** creation targets a matching coordinator agent as a worker
- **THEN** the target is rejected without changing another agent.

#### Scenario: Rejects disallowed coordinator tool execution

- **WHEN** a matching coordinator requests a tool outside its permitted set
- **THEN** execution is rejected independently of context filtering and configured denials remain final.

#### Scenario: Preserves cross-project control under inherited policy

- **WHEN** a coordinator controls a selected session in another project
- **THEN** the operation uses the selected native location without requiring terminal attachment or a coordinator in the storage directory.

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

#### Scenario: Preserves populated stores across manual assignments

- **WHEN** a session-centric store is reloaded after session control
- **THEN** its followers, pending notifications and unresolved native deliveries remain intact.

#### Scenario: Rejects invalid manual-delivery records

- **WHEN** persisted delivery identities are malformed or exceed retention bounds
- **THEN** state loading fails without silently dropping records.

### Requirement: Authorised shared-state inspection

The plugin SHALL expose follower state only through verified native coordinator context.

#### Scenario: Bootstraps without disclosing task state

- **WHEN** bootstrap lacks verified coordinator identity
- **THEN** it returns only availability metadata, not followed sessions or pending notification content.

#### Scenario: Rejects unauthorised shared-state reads

- **WHEN** an unrelated role or caller-supplied identity requests full state
- **THEN** no follower snapshot is disclosed.

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

### Requirement: Conversational manual assignment

The coordinator SHALL send requested input directly to selected sessions without task, observer, resume or automation prerequisites.

#### Scenario: Takes over a selected session without inventing work

- **WHEN** a user selects a session for management without an assignment
- **THEN** adoption starts following and sends no invented prompt, agent switch or interruption.

#### Scenario: Sends repeated assignments without automation prerequisites

- **WHEN** the coordinator sends successive assignments permitted by configured policy
- **THEN** each reaches the selected session without task binding or automation allowances.

#### Scenario: Rejects changed or unapproved manual targets

- **WHEN** configured policy denies admission or the selected target is unavailable
- **THEN** no prompt is admitted to a substitute target.

#### Scenario: Retains an uncertain manual send without resending

- **WHEN** a send may have been accepted but acknowledgement is lost
- **THEN** its identity survives reload and reconciliation precedes any retry of that invocation.

### Requirement: Explicit native subtree deletion

The coordinator SHALL delete a selected native subtree through its typed native control subject to configured permissions.

#### Scenario: Deletes the approved native subtree and preserves task history

- **WHEN** configured policy permits deletion of a selected subtree
- **THEN** removal executes once and affected followers stop while retained delivery identities remain intact; no task history is created.

#### Scenario: Rejects unsafe deletion and retains uncertain outcomes

- **WHEN** the root is unavailable, contains the invoking coordinator or removal acknowledgement is uncertain
- **THEN** no substitute deletion or blind retry occurs and uncertainty remains identifiable.

### Requirement: Full native session controls

The coordinator SHALL expose dedicated typed native controls governed by configured OpenCode permissions without task prerequisites or forced Backseat asks.

#### Scenario: Executes approved native session operations

- **WHEN** a coordinator requests a supported creation, import, fork, update, move, agent/model, input, command, shell, skill, generation, compaction, revert, interrupt, background, wait, inbox, form, instruction or environment operation
- **THEN** its typed native contract receives the explicit target and arguments and returns the native outcome without claiming completion from admission.
- **AND** successfully created, forked or imported sessions are followed without an initial message.

#### Scenario: Rejects denied stale or unsupported controls

- **WHEN** configured policy denies a control, its target is unavailable or acknowledgement is uncertain
- **THEN** the result reports denial, unavailability or uncertainty without a substitute target, generic passthrough or blind retry.

### Requirement: Explicit native request replies

The coordinator SHALL answer selected current native permission and form requests using its judgment and user instructions, subject to configured policy on the reply operation.

#### Scenario: Replies to the selected native request

- **WHEN** the coordinator chooses a permission decision or typed form answer for a current followed-session request
- **THEN** the matching native reply API receives exactly that decision or answer without requiring a second human decision when configured policy allows it.

#### Scenario: Rejects a changed or unapproved reply

- **WHEN** configured policy denies a reply or the selected request is no longer current
- **THEN** the operation reports denial or stale request without replying to a different request.

### Requirement: Hierarchical session control

The coordinator SHALL control and adopt selected child sessions independently of their parents and siblings.

#### Scenario: Adopts a selected child without widening ownership

- **WHEN** a coordinator adopts a selected child
- **THEN** only that child is followed without implicitly following its parent, siblings or descendants.

#### Scenario: Rejects changed hierarchical targets

- **WHEN** the selected child is unavailable at the requested location
- **THEN** control fails without retargeting another hierarchy member.

### Requirement: Compatible session-delivery persistence

The coordinator SHALL preserve unresolved native delivery identities within the session-centric store across reloads.

#### Scenario: Reloads task-free delivery state without resetting tasks

- **WHEN** a session-centric store reloads with an uncertain send
- **THEN** reconciliation uses its original delivery identity without creating a task or duplicate delivery.

#### Scenario: Rejects incompatible delivery records without reset

- **WHEN** stored state is incompatible, malformed or over retention bounds
- **THEN** loading fails without overwriting state or forgetting unresolved identities.

#### Scenario: Retires confirmed deliveries without replaying expired invocations

- **WHEN** bounded retention retires confirmed deliveries
- **THEN** unresolved deliveries remain pinned and expired invocations cannot replay an effect.

## ADDED Requirements

### Requirement: Background followed-session events

The plugin SHALL wake a session's following coordinator when native progress, idle, failure, permission or form activity occurs without requiring foreground polling.

#### Scenario: Delivers actionable events without an initial send

- **WHEN** an adopted session progresses, becomes idle, fails or requests permission or form input
- **THEN** its coordinator receives a background notification with session identity, event kind and applicable request identifiers, enabling inspection and native control.
- **AND** notifications queue while the coordinator is busy and do not send input to the worker.

#### Scenario: Coalesces bounded progress without hiding requests

- **WHEN** events arrive faster than coordinator delivery
- **THEN** progress is coalesced, request identities and terminal outcomes remain actionable, and bounded processing retains continuation rather than silently dropping unrepresented events.

#### Scenario: Recovers following across reloads

- **WHEN** the plugin reloads after native events or an uncertain notification admission
- **THEN** observation resumes from persisted progress and reconciles the original notification identity without blind resend.

#### Scenario: Reports observation discontinuity

- **WHEN** a saved native boundary is unavailable or history changes
- **THEN** the coordinator receives explicit discontinuity rather than fabricated continuous progress.

### Requirement: Explicit following lifecycle

The coordinator SHALL stop following selected sessions without interrupting their native work.

#### Scenario: Stops following without worker effects

- **WHEN** the owning coordinator stops following a session
- **THEN** pending unsent notifications and future observation stop without interrupting, deleting or messaging the worker; stale in-flight work cannot recreate following.

#### Scenario: Prevents notification feedback

- **WHEN** adoption targets the coordinator itself or creates a follower cycle, or notification-origin activity is observed
- **THEN** self/cyclic following is rejected and notification activity does not recursively generate notifications.
