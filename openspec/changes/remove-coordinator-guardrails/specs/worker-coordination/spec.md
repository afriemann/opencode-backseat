## MODIFIED Requirements

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
- **AND** a continuation stays valid for one hour after its last use.

#### Scenario: Reports snapshot capacity exhaustion

- **WHEN** a new snapshot does not fit the memory budget
- **THEN** the least recently used snapshots are evicted first, and the read fails with a capacity error naming the budget only if the snapshot alone exceeds it.

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

#### Scenario: Adopts an archived session

- **WHEN** a coordinator adopts an archived session selected by exact identity
- **THEN** following binds that session under configured permissions.

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
