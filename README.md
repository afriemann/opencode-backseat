# opencode-backseat

Coordinate parallel OpenCode sessions from one conversation: find workers, follow their progress, and control them through the **Backseat Coordinator** agent.

## Getting started

Backseat targets **OpenCode 2.2.5 (V2)** on Linux, with **Bun 1.4.4** and `/usr/bin/flock`. Development also requires Node.js 22.5 or later. Compatibility with later OpenCode versions has not been verified.

1. In a checkout of this repository, run `make install`.
2. Add the plugin to your project's `opencode.json` or `opencode.jsonc`, using the absolute path to your checkout:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [{ "package": "/absolute/path/to/opencode-backseat" }],
   }
   ```

3. Select **Backseat Coordinator** (`backseat-coordinator`) in the agent picker and say: "Show my sessions and take over the one titled 'API cleanup'."

The coordinator can discover native sessions across projects, including sessions Backseat did not create. It does not change your default agent or model. All coordination happens in the conversation; there is no separate terminal UI.

Session listing can filter by status, project, location and subpath, agent, title and update or creation time (for example, sessions not updated in five days). Status checks are skipped when only metadata is needed, and slow status reads are deferred to a continuation, so large inventories list reliably on a busy host.

The coordinator reads whole sessions, including archived ones, and exports are unredacted by default, so user text, reasoning and tool output reach the coordinator model and its transcript; ask for a redacted export explicitly if you do not want that. Large reads are served in consistent chunks from a snapshot that stays valid for one hour after its last use.

It can also use your configured ticket, recall and tracking tools, including session-local todos when available. Other tool actions default to `ask`; your configured native permissions still apply. MCP calls request native permission automatically, while custom plugin tools are responsible for their own permission checks. Built-in implementation tools remain unavailable to the coordinator.

## Follow an existing session

Taking over a session starts background following immediately. It sends no initial message and does not interrupt work already running. No task, goal questionnaire, send ID, or supervision start/resume step is needed.

- "Take over that session and tell me when it finishes."
- "When the worker needs permission to run the tests, handle it and continue."
- "Read its latest replies and ask it to fix any failing tests."
- "Show the sessions you're following."
- "Stop following that session."

Idle, failure, permission and form events wake the owning coordinator. Progress updates are coalesced rather than generating a message for every event. The coordinator decides what action to take under your instructions, including replying to worker permission requests and forms. OpenCode's configured allow, ask and deny rules still apply; Backseat adds no forced approval prompt to an allowed operation.

Following selects exactly one session. Selecting a child does not take over its parent or siblings. Stopping following leaves the worker running and does not retract messages already delivered. Following resumes when the plugin reloads; transient events that occurred entirely while it was offline cannot all be reconstructed.

## Start workers and control sessions

Ask the coordinator to create a worker in a selected project using an available agent. Creation starts following but sends no assignment until the coordinator chooses to send one. It can also import or fork native sessions, read messages, change agents and models, manage queued input, interrupt execution, compact history, run native commands and answer pending requests.

After sending, the separate `follow_session` content reader can track responses from the returned send ID. Background following does not require this reader or an initial send.

If creation, deletion or a send reports an uncertain outcome, retain its returned identity and reconcile it instead of blindly repeating the action. Commands and skills cannot confirm a lost acknowledgement by a caller-selected message ID. Deleting a session also deletes its child sessions; Backseat retains delivery records, so deletion is not a full data purge.

## Configuration

| Option    | Default                                                                   | Effect                                                            |
| --------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `dataDir` | `$XDG_DATA_HOME/opencode-backseat`, or `~/.local/share/opencode-backseat` | Absolute directory for coordination state shared across projects. |

Set plugin options in the configuration entry:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-backseat",
      "options": { "dataDir": "/absolute/path/to/backseat-state" },
    },
  ],
}
```

## Troubleshooting

- **Coordination unavailable:** run `make prerequisites` to check Linux and `flock`, then inspect the reported storage or ownership reason. Do not delete the lockfile. A terminated owner is reacquired automatically; a live owner continues to block competing ownership.
- **Uncertain delivery:** retain the send or session ID and ask the coordinator to reconcile it. Do not resend the assignment to test whether it arrived.
- **Incompatible state:** this version does not migrate task-based stores. Keep the existing directory and use a separate empty `dataDir` for this version, or a compatible plugin version for the existing store.
- **Missing progress:** ask the coordinator to inspect the followed session directly. Discontinuities are reported rather than treated as proof that no activity occurred.

See [AGENTS.md](AGENTS.md) for contributor guidance and run `make help` for available checks.
