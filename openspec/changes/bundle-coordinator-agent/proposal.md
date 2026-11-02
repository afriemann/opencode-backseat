# Proposal

## Why

Users need a conversational coordinator rather than a terminal setup sequence as their primary workflow. A bundled agent can manage approved task-bound workers while the plugin retains durable state, native approval and bounded supervision.

## What Changes

- Bundle a selectable `conman-coordinator` primary agent at the canonical coordinator home without a separate agent installation, model override or default-agent change.
- Preserve user-defined agent collisions and keep the coordinator role out of worker assignments.
- Restrict the bundled role to coordination tools and user questions, retaining native consent rather than shell, editing or permission-reply powers.
- Use OpenCode's native agent picker and a natural conversation as the single entry point; remove the session-creation and assignment wizard.
- Require the dedicated bundled role for coordinator operations rather than reusing unrelated agents or switching existing sessions.
- Document conversational task management and the limits of existing discovery tools.

## Capabilities

### Modified Capabilities

- `worker-coordination`: bundled conversational coordination and coordinator/worker role separation.
- `coordination-tui`: native agent selection instead of guided startup, with supporting approval, status and supervision controls.

## Impact

New agent definition in `src/coordinator-agent.ts`; registration and target guards in `src/server.ts`; startup and selection in `src/tui.ts` and `src/ui.ts`; existing worker-coordination, coordination-TUI and private-host tests; README usage.

Excluded: dotfiles/configuration edits, additional dependencies, relaxed backend authority, automatic consent, headless supervision, service restarts, live worker creation or arming, and publication. The local checkout remains the configured plugin package.
