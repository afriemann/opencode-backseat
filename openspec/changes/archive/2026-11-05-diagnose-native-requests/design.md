# Design

## Context

See proposal.md. Each native read owns a guarded-fetch closure and receives inventory's DiagnosticContext. The guard observes response headers before SDK parsing or error suppression. Existing deadlines, caller APIs and Effect host logging remain unchanged.

## Decisions

- Instrument the guard, not SDK callers, to capture swallowed failures. Reuse DiagnosticContext correlation. Choose requestDurationMs because durationMs measures enclosing work.
- Match methods and anchored route templates to fixed requestCategory labels: info, identity, projects, agents, sessions, activity, session, permissions, forms, form, inbox, messages, unknown. Static routes precede parameter routes; discard captures, URLs and queries.
- Emit native.request.completed at debug or native.request.failed at warn with requestCategory, requestDurationMs, optional httpStatus and errorCode. Measure monotonic guard-entry-to-headers/rejection elapsed time, excluding body parsing. Never clone/tee/consume bodies.
- Cap terminal records at 32 per read. Count suppressed failures by category; flush native.request.suppressed at warn with requestCategory and count once per category on read exit. Suppressed successes need no summary. This bounds fanout logging without hiding failures.
- On deadline abort, emit native.requests.deadline at warn with count equal to total active fetches, including zero. Emit native.request.active once per nonempty category with requestCategory, count and requestDurationMs equal to its oldest active elapsed time. Snapshot before rejection removes entries; zero distinguishes an empty snapshot without attributing an endpoint. Reuse the deadline signal, not extra timers.
- Keep only categories, numeric starts and counts in read-local diagnostic state. Remove listeners/state on exit and disable late emissions. Project fresh primitives before injected emitters and independently at hostDiagnostics: integer httpStatus 100-599, finite nonnegative durations, safe nonnegative integer counts.
- Choose errorCode from ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, ABORT_ERR, UND_ERR_CONNECT_TIMEOUT, UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT, unknown. Guarded own-data-descriptor extraction through one cause level avoids getters and contains proxy exceptions. Isolate diagnostic failures from origin/redirect rejection, cancellation, disposal, sanitized errors and results.

## Risks / Trade-offs

Headers can precede a stalled body; no active fetch means no endpoint attribution. Unknown labels sacrifice detail for privacy. Read-local state confines interference without retries or persistence.
