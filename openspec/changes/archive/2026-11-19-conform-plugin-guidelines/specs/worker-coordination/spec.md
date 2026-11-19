## MODIFIED Requirements

### Requirement: Diagnostic privacy boundary

Backseat SHALL restrict diagnostic records to a closed allowlist of fixed event, operation, phase, failure, request-category, error-code and configuration-option labels, the fixed plugin runtime label, plugin and host version labels of numeric dotted form, integer HTTP statuses from 100 through 599, nonnegative finite durations and counts, continuation-presence booleans, and independent diagnostic-only tokens.

#### Scenario: Excludes sensitive diagnostic data

- **WHEN** input, native metadata or an exception contains sensitive or arbitrary values at any logging level
- **THEN** diagnostics exclude exception objects, messages and stacks, URLs, paths, registration contents, prompts, titles, payloads, native/session identifiers, cursors, continuation handles, possession proofs and content-derived hashes
- **AND** existing detailed user-facing registration errors remain unchanged
- **AND** both the native producer and host projection reject arbitrary labels and invalid numbers independently, using fixed unknown categories or codes rather than exception text
- **AND** exceptional diagnostic property access or emission does not change results, original errors, permission checks, cancellation or cleanup

#### Scenario: Reports resolved configuration without option values

- **WHEN** setup completes
- **THEN** the setup diagnostic carries the plugin and host versions, the runtime label and the names of the configured options
- **AND** no option value is logged.

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

- **WHEN** a coordinator updates a session whose recorded location directory no longer exists, or which has no agent, selecting it by sessionID alone or with its recorded location and, if it has one, its agent
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

#### Scenario: Addresses an existing session by ID alone

- **WHEN** a coordinator sends input to or controls an existing session, other than creating or importing one, giving only its sessionID
- **THEN** the operation targets that session at its live location and agent under configured policy, including when its agent no longer exists.
- **AND** a supplied location or agent that differs from the live session is rejected without acting.

#### Scenario: Requires a visible description on inserted synthetic text

- **WHEN** a coordinator inserts synthetic text without a description or with a blank description
- **THEN** the call is rejected before any native call.
- **AND** a non-blank description is forwarded with the text so the host shows a row for it.

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
- **BUT** when an observation read merely times out, is cancelled or the native service is unreachable, the saved boundary is kept and observation is retried with backoff from it; discontinuity is reported only if the failure persists beyond a bounded number of retries.

#### Scenario: Notifies when a followed worker finishes a turn

- **WHEN** a followed session's native execution succeeds
- **THEN** its coordinator receives an idle notification for that session.

#### Scenario: Shows each notification in the coordinator transcript

- **WHEN** a background notification is delivered to a coordinator
- **THEN** it carries a fixed non-empty description so the host shows a visible row for it.
