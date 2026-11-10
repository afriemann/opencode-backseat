## MODIFIED Requirements

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
