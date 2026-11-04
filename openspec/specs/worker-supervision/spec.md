# worker-supervision Specification

## Purpose

React to finished worker executions with bounded, goal-based decisions without granting consent, confusing idle with success or repeating uncertain dispatches.

## Requirements

### Requirement: Settled-work supervision

The coordinator SHALL evaluate eligible bound workers only from fresh native worker-observer evidence of settled execution without pending input, tools or background work.

#### Scenario: Evaluates a settled cross-project worker

- **GIVEN** an actively owned worker in another local project finishes its execution
- **WHEN** the approved connected native TUI correlates that worker's empty-background observation with current native history, activity and human-input state
- **THEN** it obtains a task-scoped evaluation without restricting worker tools or trusting a coordinator-local idle flag or arbitrary RPC observation claims.

#### Scenario: Defers background work and holds abnormal termination

- **WHEN** an observation represents unfinished work, outstanding or unproven background work, a missing or stale worker observer, failure, interruption or unreadable state
- **THEN** no follow-up is sent; unfinished work is deferred and uncertainty is visibly held, without treating descendant success as a fresh empty ancestor observation.

### Requirement: Prompt-only automatic action

The coordinator SHALL restrict automatic actions to in-scope worker follow-up prompts selected as continue or redirect decisions.

#### Scenario: Continues an eligible task within scope

- **GIVEN** a current validated decision and no pending human input
- **WHEN** the decision continues or redirects the bound task within its existing scope
- **THEN** the approved native TUI admits a fixed non-consent, scope-validated follow-up only to that worker, without changing agent, permissions, approval policy or task scope.

#### Scenario: Preserves human approval requests

- **WHEN** latest-readable worker state reveals a pending permission, form, consent or scope-expansion request, an ask is observed during evaluation, or a proposed prompt would supply consent or override a hold
- **THEN** automation holds and invalidates that evaluation for explicit human action; it never calls reply APIs or supplies consent in prompt text, including when asks arise between non-atomic reads and admission.

### Requirement: Durable automation bounds

The coordinator SHALL enforce finite worker, shared reasoning-capacity, retained-record, byte, follow-up, decision-age and nonprogress limits across turns and reloads.

#### Scenario: Exhaustion holds the task

- **GIVEN** defaults of eight active workers, three automatic follow-ups per task, twenty-minute decision expiry and two consecutive nonprogress decisions
- **WHEN** an action would exceed an applicable limit
- **THEN** it is rejected or visibly held before exceeding the limit; suggestion and validation share bounded capacity and require current observer possession, while retained evidence and unresolved identities are not silently pruned.

#### Scenario: Reload preserves consumed limits

- **GIVEN** a task has consumed its automatic follow-up allowance
- **WHEN** the plugin reloads and the user explicitly rearms coordination
- **THEN** that allowance remains consumed and no additional follow-up is admitted unless the user explicitly authorises a new finite limit.
- **AND** changing the coordinator's project while using the same store does not reset consumed limits or discard uncertain delivery identities; obsolete decisions remain ineligible, and fresh approval and native reconciliation are still required.

### Requirement: Current decision binding

The coordinator SHALL dispatch a supervision decision only while its task, worker, ownership and observer generations, goal revision, native boundary, evidence fingerprint and shared-context versions remain current.

#### Scenario: Invalidates a changed decision input

- **GIVEN** an evaluation is in progress
- **WHEN** ownership, observer incarnation or generation, goal, native worker or descendant boundary, evidence, binding or shared-context authorisation changes
- **THEN** its result is discarded and cannot send a follow-up or mark the task complete.

#### Scenario: Holds an invalid evaluator result

- **WHEN** suggestion or bounded task-only validation fails, or returns malformed, expired, unknown-target, unsupported or out-of-scope instructions
- **THEN** the task is visibly held; a validation judgment cannot generate follow-ups, supply consent or grant control authority.

### Requirement: Reconciled prompt admission

The coordinator SHALL preserve dispatch identity through uncertain admission and reconcile it before considering another send.

#### Scenario: Reconciles an already admitted follow-up

- **GIVEN** a stored dispatch intent whose acknowledgement was lost
- **WHEN** recovery finds that intent's delivery identity in worker inbox or durable history
- **THEN** it records the admitted outcome without sending a duplicate follow-up.

#### Scenario: Holds an ambiguous delivery

- **GIVEN** a crash, timeout or reload left delivery uncertain
- **WHEN** reconciliation cannot establish whether the worker received the prompt
- **THEN** the task stays visibly held for human reconciliation rather than blindly retrying or silently reviving work.

### Requirement: Evidence-based completion

The coordinator SHALL mark a task complete only from current evidence attributable to its approved success criteria.

#### Scenario: Completes against supported success criteria

- **GIVEN** current completed native-call evidence supports each approved criterion with inspectable inputs, results and identities
- **WHEN** bounded task-only validation assesses those relationships and the approved native TUI independently rechecks native provenance and current decision identity
- **THEN** the coordinator records criterion relationships, bounded rationales and native call identities/fingerprints, not raw tool inputs/results; assistant claims or arbitrary RPC reports cannot manufacture provenance.

#### Scenario: Escalates unsupported completion claims

- **WHEN** a worker is merely idle or claims success without supporting evidence for its criteria
- **THEN** the task is not marked complete and the coordinator holds or escalates the missing evidence.

### Requirement: Connected supervision recovery

The coordinator SHALL allow automatic follow-ups only through the currently approved, connected native TUI.

#### Scenario: Disconnect stops future follow-ups

- **GIVEN** a native TUI supervises a worker
- **WHEN** it closes or loses its usable connection
- **THEN** future admission stops without killing running workers; an in-flight delivery may already have landed and is reconciled or held, not rolled back or blindly retried.

#### Scenario: Reconnect inventories before rearming

- **GIVEN** supervision was disconnected
- **WHEN** the user reconnects and explicitly rearms its observer generation
- **THEN** workers, human asks and unresolved delivery identities are reconciled before eligibility returns; obsolete reports and decisions are discarded and consumed limits remain consumed.

### Requirement: Native-default background evaluation

The coordinator SHALL use OpenCode's resolved default model for the initiating coordinator's actual project when performing background task evaluation.

#### Scenario: Uses the coordinator-project native default

- **GIVEN** a verified coordinator session and a native default model available at its actual project
- **WHEN** a background suggestion or bounded validation is requested
- **THEN** generation explicitly uses that resolved model with only the task-scoped evaluation input.
- **AND** the conversation's selected model remains unchanged; no Backseat model setting, worker-project model, title-agent model or data-directory configuration substitutes for that default.

#### Scenario: Holds unavailable default-model evaluation

- **WHEN** native model resolution fails, returns no model or a mismatched project, or generation fails
- **THEN** evaluation remains visibly held or unavailable without a follow-up or completion record, a guessed model fallback or an automatic retry.
