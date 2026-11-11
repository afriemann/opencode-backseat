# worker-coordination Specification

## Purpose

Follow explicitly selected native OpenCode sessions and deliver background events to their owning coordinator while preserving configured native permissions and exact session control.

## Requirements

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

- **WHEN** another coordinator that has an active run already follows the selected session
- **THEN** adoption reports the conflict without taking over that follower.

#### Scenario: Takes over from an idle or vanished coordinator

- **WHEN** the coordinator following the selected session is idle or its session no longer exists
- **THEN** following transfers to the adopting coordinator without messaging or interrupting the worker, and pending events carry over.
- **AND** the adoption result names the previous coordinator and the reason for the takeover.

#### Scenario: Rejects stale or denied task-free adoption

- **WHEN** configured permissions deny adoption or the selected native session is unavailable
- **THEN** no follower is created and no substitute target or initial message is used.

#### Scenario: Adopts an archived session

- **WHEN** a coordinator adopts an archived session selected by exact identity
- **THEN** following binds that session under configured permissions.

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

#### Scenario: Allows Backseat operations by default

- **WHEN** the coordinator invokes a Backseat native operation and no inherited rule matches its `backseat.` permission action
- **THEN** the operation is allowed, while an inherited ask or deny rule appended to the coordinator's permission prefix still applies.

### Requirement: Restricted conversational coordination

The plugin SHALL restrict matching coordinator roles from built-in implementation tools while leaving other configured tools eligible under native OpenCode permissions.

#### Scenario: Preserves native approval for conversational control

- **WHEN** a matching coordinator invokes a native control
- **THEN** configured allow proceeds without a forced Backseat ask, configured ask requests approval and configured deny rejects the operation.
- **AND** the `backseat` namespace, `backseat_` tool identifiers and `backseat.` permission actions remain consistent, without aliases or terminal UI.
- **AND** worker content is evidence, not a user instruction; the coordinator can still judge actions and worker request replies.

#### Scenario: Rejects coordinator worker assignments

- **WHEN** creation targets a matching coordinator agent as a worker
- **THEN** the target is rejected without changing another agent.

#### Scenario: Rejects disallowed coordinator tool execution

- **WHEN** a matching coordinator requests `shell`, `bash`, `edit`, `write`, `patch`, `read`, `glob`, `grep`, `webfetch`, `subagent`, `skill`, or a tool in the `lsp_` or `use_` families
- **THEN** it is absent from the prompt-facing tool catalog and execution is rejected independently of context filtering, including nested Code Mode calls and inherited allow rules.
- **AND** configured denials remain final.

#### Scenario: Preserves cross-project control under inherited policy

- **WHEN** a coordinator controls a selected session in another project
- **THEN** the operation uses the selected native location without requiring terminal attachment or a coordinator in the storage directory.

#### Scenario: Allows configured coordination tools and session-local tracking

- **WHEN** a matching coordinator uses an available configured tool outside the built-in implementation denials, including session-local todo tools
- **THEN** Backseat neither removes it from the prompt-facing catalog nor rejects its execution.
- **AND** tools for unrelated agents remain unaffected.

#### Scenario: Asks for unmatched coordination tool actions

- **WHEN** a tool checks a permission action with no specific matching coordinator rule or inherited override
- **THEN** the bundled permission fallback is ask, while `execute`, `question`, available `todowrite` and `todoread`, and Backseat actions retain allow defaults.
- **AND** inherited allow, ask or deny rules still override those defaults without changing coordinator recognition.
- **AND** Backseat does not add a universal permission assertion to custom plugin tools that do not check their own permissions.

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

### Requirement: Authorised shared-state inspection

The plugin SHALL expose follower state only through verified native coordinator context.

#### Scenario: Bootstraps without disclosing task state

- **WHEN** bootstrap lacks verified coordinator identity
- **THEN** it returns only availability metadata, not followed sessions or pending notification content.

#### Scenario: Rejects unauthorised shared-state reads

- **WHEN** an unrelated role or caller-supplied identity requests full state
- **THEN** no follower snapshot is disclosed.

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

#### Scenario: Coordinator preserves worker lifecycle

- **WHEN** the coordinator assigns work to a worker or a worker stops at a gate of its own
- **THEN** the coordinator's instructions forbid prescribing or overriding the worker's process and require relaying the gate to the user unless the user delegated the decision.

### Requirement: Explicit native subtree deletion

The coordinator SHALL delete a selected native subtree through its typed native control subject to configured permissions.

#### Scenario: Deletes the approved native subtree and preserves task history

- **WHEN** configured policy permits deletion of a selected subtree
- **THEN** removal executes once and affected followers stop while retained delivery identities remain intact; no task history is created.

#### Scenario: Rejects unsafe deletion and retains uncertain outcomes

- **WHEN** the root is unavailable, contains the invoking coordinator or removal acknowledgement is uncertain
- **THEN** no substitute deletion or blind retry occurs and uncertainty remains identifiable.

#### Scenario: Deletes a session whose location or agent is gone

- **WHEN** configured policy permits deletion of a selected session whose recorded location directory no longer exists, or which has no agent
- **THEN** removal executes under the same safeguards as any other deletion.

### Requirement: Host-integrated operational diagnostics

Backseat SHALL emit structured operational diagnostics through host logging, subject to the host minimum level.

#### Scenario: Routes diagnostics through host logging

- **WHEN** lifecycle, tool, RPC, native read, or background operations complete, fail, or degrade
- **THEN** host logs receive lifecycle information, default-visible failures and degradation, and opt-in debug details including read phases, elapsed time, aggregate counts and continuation presence
- **AND** independent diagnostic correlation connects related internal work without identifying host sessions
- **AND** native request diagnostics preserve their bounded category, request elapsed time, HTTP status and error-code fields through the same host projection

#### Scenario: Identifies native request failures without exposing request data

- **WHEN** a native request returns response headers or fails before receiving them
- **THEN** diagnostics identify its fixed request category and elapsed time to headers or failure, with valid HTTP status when available and a closed error-code label on exceptions
- **AND** failures are warning-level and successes debug-level, sharing the enclosing read correlation without changing the response or caller error
- **AND** each read emits at most 32 individual terminal request records and summarizes suppressed failures once per category on exit

#### Scenario: Reports active requests at the shared deadline

- **WHEN** the enclosing native-read deadline expires
- **THEN** diagnostics report the number of active fetches and each active category's count and oldest elapsed time before abort rejection removes them
- **AND** an empty snapshot reports zero without attributing the timeout to any endpoint
- **AND** completed reads emit no late request diagnostics and retain no observation listeners

### Requirement: Diagnostic privacy boundary

Backseat SHALL restrict diagnostic records to a closed allowlist of fixed event, operation, phase, failure, request-category and error-code labels, integer HTTP statuses from 100 through 599, nonnegative finite durations and counts, continuation-presence booleans, and independent diagnostic-only tokens.

#### Scenario: Excludes sensitive diagnostic data

- **WHEN** input, native metadata or an exception contains sensitive or arbitrary values at any logging level
- **THEN** diagnostics exclude exception objects, messages and stacks, URLs, paths, registration contents, prompts, titles, payloads, native/session identifiers, cursors, continuation handles, possession proofs and content-derived hashes
- **AND** existing detailed user-facing registration errors remain unchanged
- **AND** both the native producer and host projection reject arbitrary labels and invalid numbers independently, using fixed unknown categories or codes rather than exception text
- **AND** exceptional diagnostic property access or emission does not change results, original errors, permission checks, cancellation or cleanup

### Requirement: Diagnostic failure isolation

Backseat SHALL preserve coordination results, original errors, permission checks, cancellation and cleanup behavior when diagnostic processing fails.

#### Scenario: Logging failure preserves coordination outcomes

- **WHEN** diagnostic token generation, record processing or host logging fails during an operation
- **THEN** its result or original error remains unchanged and required cancellation and cleanup still occur
- **AND** logging causes no retries, recursive logging or fallback sink writes

### Requirement: Native session inventory timestamps

The coordinator SHALL include numeric `createdAt` and `updatedAt` fields in each `list_sessions` row, copied from native `time.created` and `time.updated` as Unix milliseconds. `updatedAt` represents general session-update recency, not exclusively conversation activity.

#### Scenario: Returns native session timestamps

- **GIVEN** native sessions with distinct creation and update timestamps
- **WHEN** the coordinator lists sessions or follows a buffered continuation
- **THEN** each row exposes those timestamps unchanged, using refreshed detail metadata when available.

#### Scenario: Preserves timestamps when status refresh is unavailable

- **GIVEN** native list metadata with creation and update timestamps
- **WHEN** a session detail read fails and the caller includes unknown status
- **THEN** the row retains the available list timestamps with unknown status and partial inventory.

### Requirement: Native session content pagination

The coordinator SHALL retrieve bounded native session history and activity independently of task binding through dedicated content tools on its verified service.

#### Scenario: Pages selected session content incrementally

- **WHEN** a verified coordinator requests selected-session messages, one message, context, diff, queued input, pending requests, saved permissions, instructions, statistics or export content
- **THEN** the result identifies its target and requested projection, bounded content, truncation or continuation, and availability without fetching unrelated sessions or silently claiming completeness.
- **AND** message order and type remain consistent across pages; continuation handles bind caller, service incarnation, target and normalized query and have finite lifetime and capacity.

#### Scenario: Rejects invalid or unavailable content continuation

- **WHEN** the target is missing, a native read fails, or a continuation is expired, evicted, from another caller/service/target or combined with changed query arguments
- **THEN** the tool reports the concrete unavailable or invalid continuation without silently restarting or broadening the read, returning unrelated content, or changing durable state.

#### Scenario: Exports unredacted content by default

- **WHEN** a coordinator exports a session without specifying sanitize, or with sanitize false
- **THEN** the native export is requested unsanitized and user text, reasoning and tool output are returned without placeholders.
- **AND** sanitize true requests redaction explicitly.

#### Scenario: Reads content larger than eight megabytes in consistent chunks

- **WHEN** a selected read serializes to more than eight megabytes, or the session grows while chunks are being read
- **THEN** every chunk is served from one snapshot taken at the first read and the whole content can be read to its end.
- **AND** a continuation stays valid for one hour after its last use and is consumed by the read that returns its successor.

#### Scenario: Reports snapshot capacity exhaustion

- **WHEN** a new snapshot does not fit the memory budget
- **THEN** the least recently used snapshots are evicted first, and the read fails with a capacity error naming the budget only if the snapshot alone exceeds it.

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

The coordinator SHALL expose dedicated typed native controls governed by configured OpenCode permissions without task prerequisites or forced Backseat asks.

#### Scenario: Executes approved native session operations

- **WHEN** a coordinator requests a supported creation, import, fork, update, move, agent/model, input, command, shell, skill, generation, compaction, revert, interrupt, background, wait, inbox, form, instruction or environment operation
- **THEN** its typed native contract receives the explicit target and arguments and returns the native outcome without claiming completion from admission.
- **AND** successfully created, forked or imported sessions are followed without an initial message.

#### Scenario: Rejects denied stale or unsupported controls

- **WHEN** configured policy denies a control, its target is unavailable or acknowledgement is uncertain
- **THEN** the result reports denial, unavailability or uncertainty without a substitute target, generic passthrough or blind retry.

#### Scenario: Updates a session whose location or agent is gone

- **WHEN** a coordinator updates a session whose recorded location directory no longer exists, or which has no agent, selecting its recorded location and, if it has one, its agent
- **THEN** the update executes under configured policy against that exact session.
- **AND** a location that differs from the recorded one, or an agent that differs from the recorded agent, is rejected.

#### Scenario: Controls an archived session

- **WHEN** a coordinator updates, unarchives, reads or deletes an archived session selected by exact identity
- **THEN** the operation executes under configured policy against that session.

#### Scenario: Accepts long sends and payloads

- **WHEN** a coordinator sends text or an operation payload with strings longer than 12,000 characters within the payload byte bound
- **THEN** it is delivered unchanged; a payload over the bound is rejected before any native call.

#### Scenario: Reconciles a send beyond the first two hundred messages

- **WHEN** an uncertain send's message lies beyond the first 200 messages of a session
- **THEN** reconciliation pages through the history, stops at the match and reports it admitted.
- **AND** a repeated cursor ends the scan as unknown.

#### Scenario: Uses any non-coordinator native agent

- **WHEN** a coordinator creates a session, switches an agent or imports a session with a subagent-mode or hidden native agent
- **THEN** the operation proceeds under configured policy.
- **AND** a coordinator agent is rejected for all three.

### Requirement: Explicit native request replies

The coordinator SHALL answer selected current native permission and form requests using its judgment and user instructions, subject to configured policy on the reply operation.

#### Scenario: Replies to the selected native request

- **WHEN** the coordinator chooses a permission decision or typed form answer for a current followed-session request
- **THEN** the matching native reply API receives exactly that decision or answer without requiring a second human decision when configured policy allows it, and the operation returns `{ "status": "completed" }`.

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

### Requirement: Native model discovery

The plugin SHALL provide a coordinator tool that lists the enabled native models available at an absolute canonical location, giving each model's providerID, id, name, status and variant IDs in the form accepted by `switch_session_model`.

#### Scenario: Lists enabled models with variants

- **WHEN** the coordinator lists models at a location returned by list_projects
- **THEN** each enabled model is returned with providerID, id, name, status and variants, and disabled models are omitted.

#### Scenario: Lists catalogs beyond two hundred rows

- **WHEN** the native model, agent, project, pending-form or inbox list holds more than 200 rows
- **THEN** all rows are returned instead of failing as unsupported.

#### Scenario: Rejects a mismatched location

- **WHEN** the native model list reports a different location than requested
- **THEN** the tool fails instead of returning a partial or mismatched list.

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

### Requirement: Session recap

The coordinator SHALL be able to recap a selected native session through a dedicated tool governed by configured OpenCode permissions.

#### Scenario: Recaps a session with its subagents listed

- **WHEN** a coordinator recaps a session by exact identity, optionally with a focus
- **THEN** the session's own model generates the recap without inserting a message, and the result lists the session's direct child sessions with id, title, agent and status.

#### Scenario: Recaps a subagent on demand

- **WHEN** a coordinator recaps a child session using the id returned by an earlier recap
- **THEN** that child is recapped and its own children are listed.

### Requirement: Actionable native failure reporting

The coordinator SHALL report a native operation failure with its specific cause category instead of a generic connection failure.

#### Scenario: Reports an unknown worker location or agent as a validation failure

- **WHEN** worker creation names a location that is not a native project or an agent not available there
- **THEN** the failure states that the selected worker location or agent is unavailable and no session is created.

#### Scenario: Names the failing error class without exposing its message

- **WHEN** a native operation fails with an unexpected error
- **THEN** the failure names the error class and excludes the error message, URLs and registration contents.
