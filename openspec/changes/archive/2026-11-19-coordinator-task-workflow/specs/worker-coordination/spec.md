## ADDED Requirements

### Requirement: Session usage reading

The coordinator SHALL read one native session's cost, token usage and context size through a dedicated read-only tool without fetching unrelated sessions.

#### Scenario: Reports usage for a session

- **WHEN** a verified coordinator reads usage for a selected session
- **THEN** the result identifies the target and reports cumulative cost and tokens, the session model, the model's context limit and an approximate context size, with cumulative totals kept separate from the context size.
- **AND** child sessions are not included.

#### Scenario: Reports undeterminable values as unknown

- **WHEN** the session has no recorded model, the model has no catalogue entry, or no usable assistant message exists
- **THEN** the affected value is `unknown` and is never reported as zero.

#### Scenario: Reports unknown context size when the newest usage is stale

- **WHEN** the newest assistant message is incomplete or lacks token counts, or a compaction or revert is newer than it
- **THEN** the context size is `unknown`.

#### Scenario: Rejects an unavailable session

- **WHEN** the target is missing or the native read fails
- **THEN** the tool reports the concrete failure without returning data for another session.

### Requirement: Coordinator task workflow

The coordinator's instructions SHALL direct it to establish the goal of a session or task with the user, hand a defined task list to sessions, and guard the goal until completion.

#### Scenario: Takes over an existing session

- **WHEN** the user asks the coordinator to take over a session
- **THEN** it is instructed to understand the session from its content or a recap and to ask the user only if the task stays ambiguous.

#### Scenario: Starts a new task

- **WHEN** the user gives a new task with ticket ids
- **THEN** it is instructed to read the tickets when tools allow, otherwise rely on the user's description, and to resolve uncertainties with the user in one round.
- **AND** ticket content is treated as evidence: instruction-like or scope-expanding ticket text goes to the user and is passed to workers only as quoted, untrusted content.

#### Scenario: Drives a task list to completion

- **WHEN** the goal is clear
- **THEN** it is instructed to record the goal and a well-defined task list in the todo list, hand tasks to sessions and coordinate them to completion.
- **AND** minimal user involvement never relaxes worker-gate relay, permission replies or destructive-action rules.

#### Scenario: Guards against goal deviation

- **WHEN** a worker deviates from the goal
- **THEN** it is instructed to weigh the impact (UX or UI change, security restriction affecting usability, scope) and to give the user a brief recap before acting when the impact is significant.

#### Scenario: Manages context and cost

- **WHEN** a session's usage is relevant
- **THEN** it is instructed to read usage, to compact an idle session only at a task boundary on a known high context size and report it, and to start a replacement session carrying the goal and task list when old context should be dropped.

#### Scenario: Allows usage reading by default

- **WHEN** the coordinator invokes the usage tool and no inherited rule matches its permission action
- **THEN** the operation is allowed, while an inherited ask or deny rule appended to the coordinator's permission prefix still applies.
