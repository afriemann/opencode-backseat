## MODIFIED Requirements

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
