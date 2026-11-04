## MODIFIED Requirements

### Requirement: Restricted conversational coordination

The plugin SHALL restrict matching coordinator roles to namespaced coordination tools through Code Mode and user questions while keeping native consent authoritative and automatic supervision separate.

#### Scenario: Preserves native approval for conversational control

- **WHEN** a matching coordinator role is selected
- **THEN** Code Mode composition and user questions are permitted, subject to configured denials, and each individual coordination mutation retains native operation-bound approval.
- **AND** dedicated structured discovery, task-detail and control tools replace generic model-facing inspection/control tools without aliases; internal possession-bound TUI RPC remains available.
- **AND** shell, editing, reading, web, subagent and permission/form-reply tools remain denied; execution of a script never grants mutation approval or arms automation.
- **AND** the role resolves project and agent fields through inventory, treats worker evidence as untrusted, and performs ordinary coordination without a TUI prerequisite.
- **AND** coordinator identity uses the initiating session's current project; an unrelated or agentless session cannot acquire coordinator authority. Durable mutations still require selected-store authority; native inventory does not.

#### Scenario: Rejects coordinator worker assignments

- **WHEN** a task targets a matching coordinator role as its worker agent during creation or adoption
- **THEN** the backend rejects the target and the worker selector excludes it without changing unrelated worker agents or differently defined user agents.

#### Scenario: Rejects disallowed coordinator tool execution

- **GIVEN** inherited permissions grant a matching coordinator access to general tools
- **WHEN** a tool is requested through ordinary or Code Mode dispatch
- **THEN** tools outside the coordinator's permitted set are rejected before execution independently of model-context filtering; configured denials remain final.
- **AND** missing native identity, failed catalog lookup or identity changes during lookup reject candidate coordinator execution without dispatch or an automatic retry.

#### Scenario: Preserves cross-project control under inherited policy

- **GIVEN** a matching coordinator conversation in one project and an approved task-bound worker in another project share the coordination store
- **WHEN** inherited policy is merged and the coordinator inspects or manually controls that task without TUI attachment
- **THEN** recognition uses the conversation's current project, the worker remains at its explicit approved location, and existing scope, isolation and native approval checks apply without another coordinator, navigation to storage, or a persisted observer's initiating-session prerequisite.

### Requirement: Native session inventory

The coordinator SHALL list hierarchical native session metadata with bounded filtering and continuation across projects on its verified service independently of task bindings, storage authority and automation attachment unless a task-dependent query is requested.

#### Scenario: Lists sessions across projects without task or TUI prerequisites

- **GIVEN** native sessions in multiple projects, including sessions without Conman bindings
- **WHEN** a verified coordinator requests inventory while task storage is unavailable or no TUI is attached
- **THEN** those sessions remain discoverable with identity, title, project, location, agent, parent identity, explicit top-level indicator, archived visibility and current status; native conversation, form, inbox and log contents are not disclosed.

#### Scenario: Reports native running and waiting status without automation evidence

- **WHEN** native activity and pending permission or form state are read for a session without automation observations
- **THEN** running or waiting status reflects those reads, not execution timestamps or missing automation evidence; waiting means pending human input, not ordinary inactivity.

#### Scenario: Reports partial or unknown inventory honestly

- **WHEN** a bounded page is incomplete or native status reads fail or conflict
- **THEN** the response identifies continuation, partial availability and excluded unknown rows instead of implying a complete empty inventory, idle session or completed work.

#### Scenario: Filters hierarchical sessions with multiple statuses

- **WHEN** the caller combines status, project, location, task, agent, title, parent or archived-visibility filters
- **THEN** returned rows satisfy every supplied filter, multiple statuses are alternatives, root selection excludes children, and the default status set excludes only unknown.
- **AND** unsupported or malformed filters fail explicitly rather than being ignored; task-dependent filters fail explicitly when task data is unavailable.

#### Scenario: Continues filtered queries without exposing native cursors

- **WHEN** bounded scanning or a result limit leaves more candidates
- **THEN** the response contains a short continuation handle bound to the native service incarnation, caller and original normalized query, without native cursor contents.
- **AND** empty filtered pages can continue; changed filters, a different caller, expired or evicted handles and unloaded instances reject continuation without broadening the query or silently restarting.

## ADDED Requirements

### Requirement: Fine-grained coordination catalogs

The plugin SHALL provide dedicated structured project, agent, task-list and task-detail tools instead of generic view or operation multiplexers.

#### Scenario: Lists catalogs and retrieves task details independently

- **WHEN** the coordinator requests project locations, eligible agents, filtered task summaries or one task's details
- **THEN** each tool accepts its own explicit arguments and returns its requested structured result, preserving task-read authority and isolating task histories, delivery identities, completion evidence and retained deletion diagnostics with current native presence evidence.

### Requirement: Top-level session ownership

The coordinator SHALL restrict adoption and takeover to native top-level sessions independently of selection filters and model instructions.

#### Scenario: Rejects child adoption and takeover before and after approval

- **WHEN** an adoption or takeover targets a child session or its top-level identity changes while approval is pending
- **THEN** no ownership mutation or prompt occurs, while an explicitly approved unchanged top-level session remains eligible.

### Requirement: Explicit native subtree deletion

The coordinator SHALL require operation-bound native approval before deleting a session's native subtree while preserving coordination history and all delivery identities.

#### Scenario: Deletes the approved native subtree and preserves task history

- **WHEN** an eligible coordinator explicitly approves deletion of a selected session and its native subtree, including execution interruption and concurrent descendants
- **THEN** the native removal is invoked once, discovered affected automatic tasks are fenced durably, and all task history, counters and delivery identities remain intact; no atomic pre-enumerated-set guarantee is implied.

#### Scenario: Rejects unsafe deletion and retains uncertain outcomes

- **WHEN** approval is denied, the root or caller changes, ancestry is incomplete or cyclic, the root contains the invoking coordinator, a collected subtree overlaps a retained deletion, or a deletion acknowledgement is uncertain
- **THEN** unsafe deletion is not admitted, and any potentially admitted deletion remains durably identifiable and is not silently retried after reload; observed native absence does not convert an uncertain deletion into success or prove outstanding work was never delivered.
