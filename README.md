# opencode-backseat

Coordinate parallel OpenCode sessions from one conversation. Backseat helps you
find sessions, start workers in different projects, and assign work to existing
sessions without switching between them.

Use the **Backseat Coordinator** agent for everyday coordination. An optional
terminal overview adds automatic follow-ups for tasks you want to supervise.

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

Taking over an existing session doesn't send it a message or interrupt its
current work. Only top-level sessions can be taken over, not their subagents.
Workers still need you to answer their permission requests and questions.

Listing sessions and assigning work do **not** require the terminal overview or
automatic supervision. Creating a worker starts its approved task, but does not
enable automatic follow-ups.

Deleting a session requires separate approval and also deletes its child
sessions. Backseat retains its own task history, so deletion is not a full data
purge.

## Optional automatic supervision

Use `/coordinate` to open the terminal overview. To enable automatic follow-ups,
choose **Coordinate: attach observer (native approval)**, then
**Coordinate: explicitly rearm reconciled observer**. Opening the overview alone
does not enable automation.

Supervision checks progress against the agreed task and can send follow-ups
within its scope. By default, it allows up to eight active workers and three
automatic follow-ups per task. It pauses when a worker needs human input or its
state can't be verified; it does not answer permission requests for you.

After a disconnect, reconcile the current state and explicitly rearm supervision.
Disconnecting prevents new automatic assignments, but does not cancel work
already sent to a worker.

## Troubleshooting

- **Coordination is unavailable:** check the OpenCode version and Linux
  prerequisites. From the checkout, `make prerequisites` checks the platform and
  `flock`; it does not install missing tools.
- **A task is held:** inspect its status and resolve any pending permission or
  question. Don't resend an assignment whose delivery is uncertain.
- **You need logs:** look for `backseat` in OpenCode's host log. On the verified
  Linux host this is `~/.local/share/opencode/log/opencode.log`, or the equivalent
  under `$XDG_DATA_HOME`. Other release channels may use a different log filename.

Backseat stores coordination state in `$XDG_DATA_HOME/opencode-backseat`, falling
back to `~/.local/share/opencode-backseat`. Projects share this store; it is not a
project directory you need to open. If Backseat reports a storage or ownership
problem, inspect the reported cause rather than deleting its state or lockfile.

## Contributing

See [AGENTS.md](AGENTS.md) for the architecture, source map, development setup,
and contribution workflow. Run `make help` for available checks.
