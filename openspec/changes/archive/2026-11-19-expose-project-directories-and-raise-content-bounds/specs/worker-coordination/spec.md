## ADDED Requirements

### Requirement: Native project directory discovery

The coordinator SHALL discover every directory the host reports for a project, including worktree directories, as a selectable project location.

#### Scenario: Lists a project's additional directories

- **GIVEN** a project whose host-reported directories include one that is neither its canonical path nor a sandbox
- **WHEN** projects are listed
- **THEN** that directory is returned as its own location of the project, titled with the project name and directory name, and appears once even if the host reports it repeatedly.

#### Scenario: Creates a worker in a project's additional directory

- **WHEN** a worker is created at a host-reported directory of a project
- **THEN** the worker is created and followed as at the project's canonical path.

#### Scenario: Fails explicitly when project directories cannot be read

- **WHEN** the host cannot list a project's directories
- **THEN** project discovery fails with the host's error rather than returning a partial list.

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

#### Scenario: Closes a pending gate before sending other input

- **WHEN** a followed session has a pending form or permission request and the coordinator needs to send that session other input
- **THEN** the coordinator is instructed to cancel the form or reject the permission request first, so the session is not left waiting on it.

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

#### Scenario: Returns large default pages

- **WHEN** a content read omits maxBytes
- **THEN** its page may carry up to 128,000 bytes, and an explicit maxBytes up to 1,048,576 is accepted.
