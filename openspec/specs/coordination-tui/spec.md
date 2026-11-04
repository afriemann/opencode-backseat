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

### Requirement: Dedicated coordinator entry

The terminal interface SHALL use native selection of the bundled coordination agent as its sole coordination entry path while retaining supporting approval, status and supervision controls.

#### Scenario: Starts through the dedicated native agent

- **WHEN** the user selects Backseat Coordinator in any enabled project and starts a conversation
- **THEN** the session uses the dedicated role and its coordination toolset without navigating to the data directory, a setup wizard, dummy message or automatic observer attachment.
- **AND** coordination controls reject unrelated agents and conflicting user-defined roles rather than repurposing them.

#### Scenario: Keeps native supervision explicit

- **WHEN** the user inspects coordination state or converses with the dedicated agent
- **THEN** no session creation, agent reassignment, observer approval or supervision arming is performed by overview inspection.
- **AND** bootstrap shows only store and availability metadata before approved attachment; full inventory follows successful attachment, then reconciliation and a separate explicit rearm.
- **AND** unreadable or ineligible coordinator state stays stopped with a visible reason; conversation location, store identity and explicit worker project locations remain distinct.
