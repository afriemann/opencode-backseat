# Spec Delta

## Purpose

Bind approved tasks to explicitly selected local OpenCode workers so a single coordinator can manage parallel work without confusing locations or ownership.

## ADDED Requirements

### Requirement: Approved task binding

The coordinator SHALL bind each task to an explicitly authorised goal, success criteria, constraints, scope, project location and worker agent before starting work.

#### Scenario: Creates a worker at the selected location

- **GIVEN** an authorised task and an agent available at its selected location
- **WHEN** the coordinator creates its worker
- **THEN** the new session uses that location and agent and receives only the task's authorised starting prompt.

#### Scenario: Rejects an unavailable or mismatched target

- **WHEN** a requested location is missing, its agent is unavailable, or a task lacks an authorised binding
- **THEN** no worker is started and the coordinator reports the unresolved target without substituting another project or agent.

### Requirement: Explicit adoption

The coordinator SHALL require explicit adoption of an existing worker into one active task ownership binding.

#### Scenario: Adopts the selected existing worker

- **GIVEN** an existing session, its location, agent and approved task are explicitly selected
- **WHEN** adoption is authorised
- **THEN** the coordinator binds that session without silently changing its agent or treating unrelated history as shared task context.

#### Scenario: Rejects competing ownership

- **WHEN** adoption would assign a session already owned by another active task or coordinator
- **THEN** adoption is rejected until the previous ownership is explicitly released.

### Requirement: Explicit control transitions

The coordinator SHALL apply hold, resume and takeover only to their explicitly targeted task ownership state.

#### Scenario: Takeover invalidates automatic follow-ups

- **GIVEN** a worker has a pending supervision decision
- **WHEN** its user takes over or holds the task
- **THEN** automatic dispatch is disabled and that decision becomes invalid without affecting other tasks.

#### Scenario: Resume requires fresh eligible state

- **GIVEN** a held or manually owned task
- **WHEN** its user explicitly resumes coordination
- **THEN** ownership is re-established only after current operation-bound native TUI reconciliation of the target, asks, observation and approval; incomplete or changed eligibility stays held and obsolete decisions are not dispatched.

### Requirement: Exclusive coordinator authority

The coordinator SHALL allow mutations only from the active authority for the single canonical home configured for its local service.

#### Scenario: Holds a competing or unsafe authority

- **WHEN** a conflicting service home is configured, another authority owns the home, the runtime path is unsafe, or required host capabilities including the trusted lock helper are unavailable
- **THEN** the new authority remains visibly read-only held and performs no worker dispatch or ownership mutation.

#### Scenario: Requires explicit stale-owner recovery

- **GIVEN** an authority stopped without releasing its ownership
- **WHEN** coordination restarts
- **THEN** ownership is not automatically expired or removed, and automation remains held until prior-owner termination is confirmed, recovery is authorised and coordination is separately rearmed.

### Requirement: Approved observer generation

The coordinator SHALL authorise native observer mutations only through explicit operation-bound approval of the current observer generation.

#### Scenario: Native approval binds observer generation

- **GIVEN** the selected native TUI requests attachment to its canonical coordinator
- **WHEN** a genuine native approval decision approves that observer's verifier and generation
- **THEN** only possession proofs bound to that generation and the authorised operation can mutate coordination state; an allow policy alone does not replace the explicit ask.

#### Scenario: Rejects unapproved observer mutations

- **WHEN** a request supplies only a confirmation claim, invalid possession proof, replayed operation, obsolete generation or configured denial
- **THEN** no scope, ownership, limit, dispatch intent or completion state is changed; denied replacement attachment preserves the incumbent generation, while failed durable publication is visibly held rather than reported committed.
