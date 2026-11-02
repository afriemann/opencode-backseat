# Guided coordinator startup

## Why

First-time users can discover coordination but cannot attach from the start screen without first creating a session through an unrelated prompt. Separate palette actions make the required approval and rearming sequence difficult to discover.

## What Changes

- Offer a guided Get started entry in the native overview and command palette.
- Let users explicitly reuse a valid current coordinator or create and open a blank coordinator at the canonical coordinator home without sending a prompt.
- Follow native attachment approval with a separate Start supervision or Not now choice.
- Distinguish unattached from attached-but-stopped setup, preserving created sessions and confirmed attachment when later steps are cancelled; preserve worker/coordinator separation.

## Capabilities

### Modified Capabilities

- `coordination-tui`: accessible first-run coordination and guided startup choices.

## Impact

Application files: `src/ui.ts`, `src/tui.ts`, `test/coordination-tui.test.ts`, `test/host.ts`, and `README.md`. This change also owns its OpenSpec artifacts. Backend authority, configuration, model calls, worker creation and push are excluded. Development uses isolated native fixtures, not live attachment or arming. Existing explicit attachment and rearm commands remain available.
