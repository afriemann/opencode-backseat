# Guided coordinator startup

## Context

See [proposal Impact](proposal.md#impact) for scope and affected files.

## Decisions

### Native composition

Reuse native selectors, text details, toasts, `NATIVE_UI` sizing, host typography/spacing/focus, and `applyNativeNoColor`; no added tokens, palette, dependency, custom picker, or Figma artifact. This preserves host consistency. Text labels and selection markers carry meaning without colour. Contrast verification targets 4.5:1 normal text and 3:1 large text; terminal-owned colours remain a verification constraint.

Both overview and palette expose **Get started**, invoking one queued flow. Ready users keep the normal overview. Unattached and attached-but-stopped users see distinct status/reason text. The latter proceeds directly to **Start supervision / Not now** only while its runtime attachment remains valid; unapproved reconnects take fresh native attachment approval.

The session selector offers **Use coordinator session** only after native validation. Start screen, wrong location, worker, or archived session instead offers **Create coordinator** and read-only **Inspect home**. These labels fit the measured 24-character choice budget at 32 columns. Inspect home opens existing segmented text details exposing the full canonical home through native keyboard navigation, then returns to the selector without creation or attachment. Keep this inspection reachable before creation confirmation; creation remains a blank session at the canonical home. No worker repurposing or history-wide picker. Creation uses the supplied installed-2.2.5 contract: title/location, project-default agent, no prompt or synthetic message. Navigation uses the supplied router Destination contract; verified arrival precedes the genuine native attachment ask. Supervision follows as a separate explicit choice using unchanged reconciliation/rearm checks.

### Structural target

80-column terminal; native dialog width follows host sizing:

```text
+------------------------------------------------------------+
| Coordinate / search                                        |
| Search                                                     |
| Setup: unattached                                          |
| > Get started                                              |
| Tasks: No workers available                                |
| Native navigation / select / back                          |
+------------------------------------------------------------+
```

32-column adaptation:

```text
+------------------------------+
| Coordinate / search          |
| Search                       |
| Setup: unattached            |
| > Get started                |
| Tasks: No workers available  |
| Native navigation / back     |
+------------------------------+
```

Header/footer retain native height; search and choice rows flex horizontally. Long reasons/paths wrap through existing text details, vertically scrollable. Secondary metadata drops first; status and action labels remain. Subsequent selectors replace the choice region, not a side pane.

### Input, feedback, and recovery

Inherit native search, keyboard navigation, Enter selection, visible focus/selected markers, and Escape/back cancellation. No new shortcuts. Loading names the pending stage; disabled mutations include a reason. Empty task inventory retains Get started. Errors identify the failed stage in toast/status details without optimistic success.

The operation queue plus runtime revalidation prevents repeated activation creating duplicates. Remember a confirmed created ID within this runtime and validate it before reuse, including after failed navigation. Unknown creation outcomes stop without automatic retry. No global cache or distributed persistence.

Cancellation retains blank sessions; before attachment it leaves no attachment. Denied approval leaves supervision stopped. Not now retains confirmed attachment unarmed. Private capability, generation fences, explicit reconciliation, and rearm semantics stay unchanged.
