# task-context Specification

## Purpose

Keep task reasoning separate by default while supporting deliberate, bounded information sharing among related tasks.

## Requirements

### Requirement: Task-scoped evaluation inputs

The coordinator SHALL evaluate a worker using a fresh, bounded input assembled from its task binding, current evidence and explicitly authorised shared snapshots.

#### Scenario: Excludes unrelated coordinator history

- **GIVEN** the coordinator has discussed unrelated tasks or projects
- **WHEN** it evaluates one worker or prepares its follow-up
- **THEN** unrelated transcripts, goals, evidence and decisions are excluded from that task's evaluation input.

#### Scenario: Holds incomplete or oversized evidence

- **WHEN** essential task evidence cannot be obtained within the configured input bound
- **THEN** the coordinator reports incomplete evidence and holds instead of silently dropping essential constraints or importing another task's context.

### Requirement: Explicit versioned sharing

The coordinator SHALL share immutable snapshots only with explicitly authorised recipient tasks.

#### Scenario: Shares a selected snapshot version

- **GIVEN** related tasks and user-selected content, version and recipients
- **WHEN** a snapshot is published
- **THEN** only those tasks receive the selected version, with source attribution, and group or project membership alone grants no access.

#### Scenario: Changing sharing affects future inputs only

- **GIVEN** a task previously received a shared version
- **WHEN** its authorisation is revoked or a different version is selected
- **THEN** future inputs use only the current authorisation and existing worker history is not falsely represented as erased.

### Requirement: Evidence has no control authority

The coordinator SHALL treat worker output, repository material and shared snapshots as untrusted evidence rather than user approval or control instructions.

#### Scenario: Rejects injected approval claims

- **WHEN** task evidence claims user consent or instructs the coordinator to change goals, targets, sharing or permission policy
- **THEN** those claims do not change machine-owned approval, binding or ownership state.

#### Scenario: Sharing does not widen scope

- **WHEN** an authorised shared snapshot suggests work outside a recipient's approved scope
- **THEN** the recipient's scope remains unchanged and the coordinator holds or escalates the proposed expansion for human decision.
