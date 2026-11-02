# coordination-tui Specification

## Purpose

Offer compact native OpenCode terminal controls for discovering workers, selecting project-specific agents and understanding coordination state.

## Requirements

### Requirement: Native project and worker selection

The terminal interface SHALL offer searchable native selectors for project locations, their available agents and existing workers.

#### Scenario: Selects a project-specific agent and worker

- **WHEN** the user creates or adopts a worker through coordination controls
- **THEN** the interface identifies the selected project, available agent and worker explicitly before authorising that operation.

#### Scenario: Reports discovery failure without substitution

- **WHEN** a project or agent list is empty, unavailable or fails to load
- **THEN** the interface shows an empty or error state and disables the affected operation without substituting another target.

### Requirement: Accessible coordination overview

The terminal interface SHALL expose task-group and worker state through keyboard-reachable native controls with visible textual status and selection.

#### Scenario: Retains essential status across terminal sizes

- **WHEN** the overview is viewed at its representative or narrower terminal size, including with nonempty NO_COLOR
- **THEN** project and worker status, selection, search and navigation remain usable without relying on colour; secondary metadata yields before essential state.

#### Scenario: Shows pending and unavailable states

- **WHEN** data is loading, absent or erroneous, supervision is disconnected or awaiting rearm, or a worker is held, needs human input or is complete
- **THEN** the interface names that state and displays a reason for disabled actions rather than presenting stale controls as available.

### Requirement: Authoritative native worker actions

The terminal interface SHALL route explicit worker actions to the selected worker and show their authoritative task state and shared-snapshot version.

#### Scenario: Opens the selected native worker session

- **GIVEN** a worker is selected
- **WHEN** the user chooses Open
- **THEN** its native session tab is opened or focused rather than creating a duplicate or navigating to another worker.

#### Scenario: Shows shared versions and confirmed control status

- **GIVEN** a selected task or group
- **WHEN** the user shares an explicit snapshot or chooses Hold, Resume or Takeover
- **THEN** the interface shows the immutable version or authoritative control state only after native operation approval and current-generation validation, reports failures without optimistic success, and leaves human forms and permissions in native OpenCode flows.

### Requirement: Guided coordinator startup

The terminal interface SHALL offer a keyboard-reachable guided startup flow without requiring a user prompt to establish a coordinator session.

#### Scenario: Starts from a blank coordinator without a prompt

- **GIVEN** coordination is unattached and the user opens the overview or startup palette entry
- **WHEN** the user explicitly chooses to use a valid current coordinator or create a blank coordinator at the canonical home
- **THEN** the interface opens and verifies that unarchived nonworker session before requesting native attachment approval, without a model call, user prompt or worker creation.
- **AND** HOME, archived, bound-worker and wrong-location sessions are not repurposed; ordinary overview inspection creates nothing.
- **AND** the canonical home can be inspected through read-only native details before creation, and the empty worker inventory remains visible.

#### Scenario: Keeps approval and arming separate

- **WHEN** the user cancels startup, denies attachment, or chooses Not now after confirmed attachment
- **THEN** supervision remains stopped and the interface accurately distinguishes unattached from connected-but-stopped state, retaining any confirmed session and attachment.
- **AND** only a separate Start supervision choice invokes current reconciliation and rearm; failed reads, approval, navigation or rearm never report readiness.

#### Scenario: Reuses confirmed sessions after interrupted startup

- **GIVEN** startup has created a coordinator or this runtime already has a current approved attachment
- **WHEN** the user explicitly resumes startup
- **THEN** the interface revalidates and reuses the confirmed session or attachment instead of duplicating creation or approval.
- **AND** queued activation prevents duplicate in-flight creation; an unknown creation outcome prevents automatic retry and reports how to select the resulting session, while stale attachment or reconnect requires fresh approval.
