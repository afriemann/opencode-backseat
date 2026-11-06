# opencode-backseat

Coordinate parallel OpenCode sessions from one conversation. Backseat helps you
find sessions, start workers in different projects, and assign work to existing
sessions without switching between them.

Use the **Backseat Coordinator** agent to read, control and optionally supervise
sessions. All coordination goes through the agent; there is no terminal UI.

## Getting started

Backseat targets **OpenCode 2.2.5 (V2)** on Linux, with **Bun 1.4.4** and
`/usr/bin/flock`. Development also requires Node.js 22.5 or later. Compatibility
with later OpenCode versions has not been verified.

1. In a checkout of this repository, run `make install` to install dependencies.
2. Add the plugin to your project's `opencode.json` or `opencode.jsonc`, replacing
   the path below with the absolute path to your checkout:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [{ "package": "/absolute/path/to/opencode-backseat" }],
   }
   ```

3. Select **Backseat Coordinator** (`backseat-coordinator`) in OpenCode's agent
   picker and tell it what you want to coordinate.

Add the same plugin entry to each project where you want Backseat to manage work.
You don't need global configuration or a separate coordinator conversation in
every project. The plugin does not change your default agent or model.

## Everyday use

Start with requests like these:

- "Show me the running sessions across my projects."
- "Start a worker in this project to investigate the failing tests."
- "Take over the session titled 'API cleanup'."
- "Ask that worker to run the test suite and report the results."

Before starting a worker, agree on the goal, success criteria, constraints, and
scope. Backseat asks for approval before creating a worker or sending an
assignment. It can also discover sessions that weren't created through Backseat.
Ask it to continue a session search for more matches, even after an empty result.
You can ask it to message an existing session directly without creating a task.
If the send reports an uncertain outcome, keep its send ID and ask the coordinator
to reconcile it rather than sending the assignment again.

Ask the coordinator to read a session's latest replies, retrieve older messages
in pages, or inspect an in-progress message. It can continue large reads without
returning the entire conversation on every call.
After a send, ask it to follow activity from that send ID and poll for changed
responses. Other inputs can overlap, so activity after a send is not necessarily
caused by that message. If tracking becomes unavailable, retain the send ID and
restart the read, not the assignment.

Taking over an existing session doesn't send it a message or interrupt its
current work. Select it by its title or the listing already shown; no task
questionnaire is needed. An unbound session stays task-free. An existing task
is taken under manual control, with automatic follow-ups held. Your native
approval covers the selected session. You can select a child session without taking over its parent or
siblings.
You can ask the coordinator to answer a worker's permission request or form.
Each reply needs your native approval for that exact request and answer.
Manual replies do not restart automatic supervision.

Ask the coordinator to create or import a native session without a supervised
task, fork an existing session, change its agent or model, manage queued input,
or interrupt and compact its work. Messages can include native attachments;
native commands, shell execution and skill activation require your approval too.
Keep the returned identity if creation or execution is uncertain. Command and
skill APIs cannot confirm a lost acknowledgement by a caller-selected message
ID, so Backseat does not retry those uncertain actions.
If an uncertain creation is visible, the coordinator can request separate native
approval to use that unchanged session without creating or importing it again.
Confirmed delivery records can retire as the ledger fills. An expired invocation
is rejected, not replayed; unresolved records remain protected and can still fill
the ledger. If native invocation metadata is unavailable, new sends are withheld.

Listing sessions and assigning work do **not** require automatic supervision.
Creating a worker starts its approved task, but does not
enable automatic follow-ups.

Deleting a session requires separate approval and also deletes its child
sessions. Backseat retains its own task history, so deletion is not a full data
purge.

## Optional automatic supervision

Ask the coordinator to start supervision, then resume each selected task.
Both actions require native approval. Starting supervision leaves tasks held;
resuming checks the worker's current state before enabling automatic follow-ups.
Ask the coordinator to hold or take over a task to stop its automatic follow-ups.

Supervision checks progress against the agreed task and can send follow-ups
within its scope. By default, it allows up to eight active workers and three
automatic follow-ups per task. It pauses when a worker needs human input or its
state can't be verified; it does not answer permission requests for you.

Supervision runs on the server and does not require an open terminal interface.
Losing the coordinator's identity, service connection or participating project
holds affected tasks without cancelling work already sent. After recovery,
ask the coordinator to start supervision and explicitly resume the tasks again.
Recovery does not reset consumed limits or resend uncertain assignments.

## Troubleshooting

- **Coordination is unavailable:** check the OpenCode version and Linux
  prerequisites. From the checkout, `make prerequisites` checks the platform and
  `flock`; it does not install missing tools.
- **An owner is blocking coordination:** a demonstrably stopped owner is
  reacquired automatically at startup, without starting supervision. A live
  owner, unverifiable process identity, unsafe storage or missing host capability
  remains blocked with a specific reason. Resolve that cause; do not delete the
  lockfile. Recovery is only an explicit eligible fallback, not a prerequisite
  for ordinary adoption.
- **A task is held:** inspect its status and resolve any pending permission or
  question. Don't resend an assignment whose delivery is uncertain.
- **You need logs:** look for `backseat` in OpenCode's host log. On the verified
  Linux host this is `~/.local/share/opencode/log/opencode.log`, or the equivalent
  under `$XDG_DATA_HOME`. Other release channels may use a different log filename.

Backseat stores coordination state in `$XDG_DATA_HOME/opencode-backseat`, falling
back to `~/.local/share/opencode-backseat`. Projects share this store; it is not a
project directory you need to open. If Backseat reports a storage or ownership
problem, inspect the reported cause rather than deleting its state or lockfile.
Keep this directory when updating Backseat so pending assignments remain
reconcilable. If a plugin version cannot read the stored state, use a compatible
version rather than resetting the store.

## Contributing

See [AGENTS.md](AGENTS.md) for the architecture, source map, development setup,
and contribution workflow. Run `make help` for available checks.
