# Spec Delta

## MODIFIED Requirements

### Requirement: Explicit adoption

The coordinator SHALL adopt an explicitly selected existing session through native operation approval without requiring a task unless the user requests task binding.

#### Scenario: Adopts the selected existing worker

- **GIVEN** an existing session, its location, agent and approved task are explicitly selected
- **WHEN** adoption is authorised
- **THEN** the coordinator binds that session without silently changing its agent or treating unrelated history as shared task context.

#### Scenario: Accepts task-free adoption without inventing a binding

- **GIVEN** an unbound selected root or child session and available store authority
- **WHEN** adoption without a task receives native approval
- **THEN** the coordinator returns the accepted session and an explicit unbound outcome without creating a task, exclusive session registration, worker prompt, interruption, agent switch or supervision eligibility.
- **AND** an omitted task is distinct from a supplied malformed task, which is rejected; existing explicit-task callers retain approved binding semantics.

#### Scenario: Rejects competing ownership

- **WHEN** adoption would assign a session already owned by another active task or coordinator
- **THEN** adoption is rejected until the previous ownership is explicitly released.

#### Scenario: Rejects stale or denied task-free adoption

- **WHEN** task-free adoption is denied, its selected identity, location, agent, ancestry or relevant binding changes during approval, or its binding is completed
- **THEN** no adoption effect is committed and the concrete denial, changed target or completed binding is reported without substituting a target.
- **AND** unavailable authority is an explicit error, never evidence that a session has no binding.

### Requirement: Exclusive coordinator authority

The coordinator SHALL allow mutations only through the active authority for the single canonical data store selected by its local service.

#### Scenario: Holds a competing or unsafe authority

- **WHEN** a project selects a store conflicting with the service's first active store, another process owns the store, the runtime path is unsafe, or required host capabilities including the trusted lock helper are unavailable
- **THEN** the new participant remains visibly read-only held and performs no worker dispatch or ownership mutation.
- **AND** projects selecting the same store share one serialized authority, including concurrent mutation and observation publication, rather than acquiring independent state caches.
- **AND** held metadata and task-dependent errors distinguish live contention, unverifiable owner identity, unsafe storage and unavailable host capability with fixed safe reasons, without raw owner records or exception content.

#### Scenario: Requires explicit stale-owner recovery

- **GIVEN** an authority stopped without releasing ownership and prior-owner termination is demonstrable
- **WHEN** coordination restarts and acquires exclusive ownership
- **THEN** manual store authority is reacquired during startup without separate recovery approval or supervision start, while automatic supervision remains held pending separately approved reconciliation and rearming.
- **AND** durable task records, consumed limits and uncertain task and session delivery identities are preserved; unreadable state or failed publication remains held rather than initializing an empty store or repeating worker effects.

#### Scenario: Revalidates terminated ownership under exclusive acquisition

- **GIVEN** an unreleased owner record and competing claimants
- **WHEN** startup attempts reacquisition
- **THEN** termination is established again for the current record under continuous exclusive ownership through replacement and lease retention; only one claimant gains authority and others remain held.
- **AND** missing or changed boot/namespace evidence, inaccessible process identity, malformed ownership, live owners or failed lock acquisition do not establish termination; the lock file is not cleared, deleted or recreated to bypass exclusion.

#### Scenario: Fences an unloaded project without releasing other participants

- **GIVEN** multiple enabled projects share the active store
- **WHEN** one project unloads or the final participant closes
- **THEN** the unloaded project's pending operations, asks, evaluations, observations and initiating coordinator authority cannot admit further work, while other participants retain shared ownership until final shutdown safely drains publication and releases it.
- **AND** replacement acquisition cannot overlap closing ownership; reconnect still requires fresh approval and reconciliation, preserving uncertain deliveries and consumed limits.

### Requirement: Conversational manual assignment

The coordinator SHALL admit explicitly requested assignments to selected existing sessions through operation-bound native approval without task binding, observer attachment, resume, or automation arming.

#### Scenario: Takes over a selected session without inventing work

- **WHEN** the user selects an existing session for coordinator management without requesting an assignment
- **THEN** the coordinator takes over an existing binding when present, fences automatic decisions, and sends no invented prompt, agent switch, or interruption; a session without a binding requires no fabricated task.
- **AND** the coordinator resolves take-over or adoption intent from the selected inventory and available context, asks only genuine target or outcome ambiguity, and requires no task questionnaire or placeholder criteria for ordinary adoption; unavailable binding information is not treated as an unbound session.

#### Scenario: Sends repeated assignments without automation prerequisites

- **GIVEN** a selected session with no task binding or a held or manually managed binding
- **WHEN** the user requests successive assignments and each receives native approval
- **THEN** each assignment reaches the selected worker without resume or arming, does not consume automation allowances, and leaves affected automatic dispatch disabled; bound assignments remain within their approved task scope.

#### Scenario: Rejects changed or unapproved manual targets

- **WHEN** native approval is denied, the initiating identity or selected target changes during approval, competing ownership remains, or a bound assignment's declared scope exceeds approved scope
- **THEN** no manual prompt is admitted and the concrete unresolved target or permission is reported without implicitly answering pending native asks.

#### Scenario: Retains an uncertain manual send without resending

- **WHEN** admission acknowledgement is lost or durable publication fails after a manual send may have been accepted, including a send without task binding
- **THEN** its reserved delivery identity survives reload, further sends remain blocked pending reconciliation, and no automatic resend or replacement identity is generated.
