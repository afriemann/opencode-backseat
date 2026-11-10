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

- **WHEN** a coordinator updates a session whose recorded location directory no longer exists, or which has no agent, selecting its recorded location and, if it has one, its agent
- **THEN** the update executes under configured policy against that exact session.
- **AND** a location that differs from the recorded one, or an agent that differs from the recorded agent, is rejected.

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
