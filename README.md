# opencode-conman

Native coordination for parallel OpenCode sessions. Development targets OpenCode 2.2.5; later 2.x hosts require compatibility verification.

## Conversational coordination

Select **Conman Coordinator** (`conman-coordinator`) in OpenCode's agent picker. Ask it to list sessions, take over an existing session, or start a session in a selected project. Ordinary coordination needs no TUI attachment, observer or automation arming.

The coordinator discovers sessions across all projects on the same authenticated native service, including sessions with no Conman task binding. Inventory contains session identity, title, project location, agent and native running, waiting-for-input, inactive or unknown status. Results identify partial pages and continuation cursors; unknown status is not a completion claim. Project and agent catalogs resolve targets without requiring you to supply internal identifiers. Ambiguous selections still need clarification.

The connection uses OpenCode's native service registration automatically, without endpoint or credential settings. Only a safe local registration identifying the hosting process and plugin incarnation is accepted. Unregistered, incompatible or different services report unavailable rather than starting a service or switching endpoints. Native listing remains available independently of task-store ownership; task mutations still need the selected store's authority and native operation-specific approval.

`conman_inspect` defaults to `view: "sessions"`; `projects` lists project locations, `agents` requires `location`, and `tasks` inspects durable bindings and delivery identities. Native inventory never includes conversations, form answers, inbox payloads or journal contents.

Session pages contain at most 200 rows with a continuation cursor. Project and agent catalogs exceeding 200 choices report partial unavailability; they are not silently truncated into a complete selection list.

## Worker creation

A task identifies its goal, success criteria, constraints, scope, project location and available agent. Creation checks the target, requires operation-bound native approval, and starts only that worker with the approved task immediately. Automatic follow-ups remain disabled. Existing workers are not silently reassigned.

Adopting an existing session requires explicit native approval for that worker and task. Its selected location and agent are rechecked after approval. A competing binding is rejected, including one appearing while approval is pending; existing history is never copied into another task. Adoption sends no prompt, interrupts no running turn and changes no worker agent.

Manual takeover of an existing binding suspends automatic follow-ups and invalidates the task epoch without resetting consumed limits. `dispatch` with `{text, scope}` declares a nonempty subset of the binding's confirmed scope and sends the explicitly requested assignment with native approval of the exact payload. The backend checks declared scope, not the meaning of free text. Repeated assignments need neither resume nor arming and consume no automatic follow-up allowance. The coordinator checks session status before assigning work and stops for pending human input; dispatch never detects or answers a worker's permission or form request.

Each assignment reserves its native delivery ID durably before sending. Lost acknowledgement or failed publication retains the original ID across reload and blocks another send until native delivery reads establish admission; it is never resent automatically. Manual records use the existing version-1 ledger with distinct provenance. Existing stores remain readable without migration; older plugin readers reject stores containing manual records.

## Context boundaries

Evaluation inputs contain only the approved task and its worker evidence. Unrelated coordinator history is excluded. Shared snapshots require an explicitly selected version, matching group and authorised recipient; group membership alone does not share anything. Revocation changes future inputs, not past worker history. Evidence and snapshots never grant approval or widen task scope. Missing or oversized input produces a hold rather than silent truncation.

## Supervision and ownership

The supervision core uses task-scoped suggestions, current observer/goal/turn checks and durable intent reservations. It defers known running work and holds unknown background state. Pending human asks invalidate decisions; automatic text never supplies consent. Defaults are eight active workers, three automatic follow-ups per task, a twenty-minute decision expiry and a hold after two consecutive non-progress decisions. Reload and reconnect do not reset consumed limits.

Completion requires inspectable tool evidence for every approved criterion and a trusted native validation step. A worker success claim alone is insufficient. Lost acknowledgement is reconciled by the original prompt ID or held; it is never blindly resent. Disconnect stops future admission, not work already admitted. Reconnect inventories current state and requires explicit rearming.

Suggestion and validation requests require current observer possession and share an eight-request in-flight budget. Retained state is bounded to 200 task bindings, 200 shared snapshot versions, 800 delivery intents, 200 completions and 8 MiB of UTF-8 JSON. New operations are rejected when the budget is full; unresolved delivery identities and completion provenance are never silently pruned. Inspection shows only successfully persisted state. Completion history retains native identities, fingerprints and criterion rationales, not raw tool inputs or results.

Native observation and exact-ID reconciliation inspect at most 200 messages and 1,000 journal events. A longer or unreadable history is held rather than truncated into a false settlement proof. Continuing such work requires an explicitly approved fresh worker/task binding; existing history is not automatically imported.

The ownership core rejects occupied or unsafe authority locations. Stale-owner recovery requires proof the prior owner stopped, native approval and a separate rearm. Disposal drains old effects before releasing only its own lock. Observer control uses a TUI-local Ed25519 private key and an approved server-side public verifier; requests are operation, task revision, epoch, generation and sequence bound. Replay and obsolete authority are rejected.

Loading the package does not approve an observer, arm supervision or authorise a task. Those remain separate native control actions.

## Project-local loading

Fill the portable package placeholder in `examples/opencode.jsonc`, then use that plugin entry in each participating project's `opencode.json(c)`. No global configuration is required. Conversation locations and explicitly selected worker projects are independent of coordination storage.

The plugin bundles the coordinator without changing your default agent or model. Confirm the task's criteria, constraints and scope before creation or adoption. Selecting a coordinator separately in each worker project is unnecessary.

State and ownership use `$XDG_DATA_HOME/opencode-conman`, or `~/.local/share/opencode-conman` when XDG_DATA_HOME is unset, empty or relative. The optional plugin option `dataDir` selects an absolute private directory instead. All participating projects in a service share the first registered store; a conflicting override holds coordination instead of opening another authority. The directory is data storage, not a project to navigate to. Unsafe permissions, corrupt or missing initialized state, and incomplete publication hold coordination without resetting limits or unresolved deliveries. Existing project-local state is neither imported nor deleted.

Coordination requires the dedicated role's exact identifier, instructions, visible primary mode and ordered permission prefix. OpenCode may append general permissions without making this role unavailable. The plugin limits its visible and executable tools to `conman_inspect`, `conman_control` and `question`; configured denials still apply, and control operations still require native approval. An identical configured copy receives those same restrictions, not a guarantee of bundled authorship. Differently defined user agents are preserved unchanged and cannot act as the coordinator. Matching coordinator roles cannot be used as workers; unrelated user roles remain available for worker tasks.

One coordinator conversation can manage approved workers in other participating projects through the shared store. Recognition uses the conversation's project; every worker keeps its explicitly selected project, agent, scope and native approval requirements. Selecting a coordinator separately in each worker project is unnecessary.

### Optional automatic supervision

Use `/coordinate` only when you want automatic follow-ups or the optional terminal overview. Automatic follow-ups require **Coordinate: attach observer (native approval)** followed by **Coordinate: explicitly rearm reconciled observer**. Attachment and rearming are separate, explicit actions. Resume requires the approved TUI's signed, fresh native reconciliation and operation-bound approval; stale state or pending human requests leave automation held. Bare conversational resume cannot establish eligibility. Denying a replacement observer preserves the approved observer.

Before attachment, the TUI receives only store identity and availability metadata. Full inventory requires approved attachment and a current signed request; conversational inspection requires the actual dedicated native role. A missing, stale, uncorrelated or nonempty worker observation holds supervision. Disconnect stops future admission, not an already admitted operation; reconnect requires fresh inventory and explicit rearming.

Recovery returns availability metadata, not task inventory, and requires separate attachment and rearming. If an operation commits after read eligibility changes, the TUI withholds inventory and reports the committed outcome: do not retry it; attach and reconcile explicitly.

Background suggestions and validation use OpenCode's resolved default model for the initiating coordinator's project, not the conversation's selected model, worker model or title agent. There is no separate plugin model setting. Unavailable default-model lookup or generation holds the evaluation without a fallback or worker dispatch. Each suggestion receives one bounded task-only validation pass. A validation receipt is bound to current scope, generation, native boundary, evidence and shared versions. Completion records validated criterion-to-native-call relationships and bounded rationales, not assistant success claims or caller-supplied criterion tags. Validation never grants consent, and recording does not trigger another model pass.

At narrow terminal widths, use **Coordinate: inspect shared versions** (`Alt+V`) for keyboard-accessible full snapshot identifiers and versions instead of relying on clipped overview descriptions.

When the overview is unavailable, **Status** (`Alt+I`, or the read-only status command in the palette) exposes the full affected task/worker identities and reconciliation reason. These detail rows cannot grant approval or mutate worker state.

## Development

Native ownership requires Linux, the verified Bun 1.4.4 runtime and a trusted executable `/usr/bin/flock`. Other runtimes remain held until their descriptor behavior is verified.
Run `make prerequisites` for the basic platform/helper check. The ownership
adapter also verifies path safety and actual exclusion; this check alone does
not establish filesystem safety. No helper is automatically installed.

The runtime lock inode is permanent at `dataDir/ownership.lock` alongside the private state envelope.
A short nonblocking helper acquires kernel ownership through an inherited
descriptor; the coordinator retains that descriptor. Recovery never deletes
or replaces the lockfile and never resumes workers automatically. Real Bun
descriptor-retention and recovery regressions gate reliance on this adapter.

The UI goldens inventory native-dialog content at wide and narrow sizes; they
are not OpenCode renderer captures. `make native-test` separately exercises
the installed private host, real rendering and keyboard input, and deterministic
loopback model responses without external model credentials or the managed service.

Use `make help` to list checks. `make install` installs pinned development packages; `make test` runs behavioral tests. These commands do not activate the plugin in your managed OpenCode service.

An individual suite can be selected with `make test TEST_PATH=./test/worker-coordination.test.ts`. Use `make typecheck`, `make lint`, `make coverage` and `make hooks` for the corresponding project checks.
