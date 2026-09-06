# Detached structured questions

The app adds `ask_async` through an OMP extension while preserving native blocking `ask` and interactive approvals. It accepts one to three structured questions, records them in the native session journal, returns immediately, and lets the original turn continue. An unanswered question closes when its originating turn ends; reopening after worker loss repairs an unmatched open entry as closed.

The composer card supports option choices, free text, Previous/Next, Skip and Dismiss. Choices are drafts, never implicit submissions. Cached open questions remain editable offline; Send requires reconnection. Answer drafts use the existing owning-host revision and conflict mechanism. A submitted revision is cleared only after a verified acceptance; newer edits remain intact.

## Acceptance and delivery are separate

`session.question.answer` carries the native question entry, canonical answers, submitted draft revision and existing command identity. The owning host orders the command and OMP reserves the question synchronously before flushing acceptance. Competing clients cannot both resolve it. A worker response lost after acceptance is reported as unknown. A durable native snapshot can reconcile that exact command and draft revision; an in-memory entry with a failed flush cannot establish acceptance.

Accepted answers wait durably until their host is eligible to deliver. An ordinary unsent conversation draft, archive, interruption or pending native interaction holds delivery. The answer becomes one ordinary native user message through steer during a running turn or follow-up while idle. Admission and turn completion are tracked separately, so Stop and other host commands remain responsive while a native tool runs. A delivery attempt without a durable result is shown as unknown and is not replayed automatically.

The native journal is authoritative. `questionDeliveryPending` is only a persisted scheduler wake-up hint. Question observations validate owning host and session identity in the main-process transport and cache. Credentials remain in the owning host transport.

## Evidence boundary

Source tests exercise real OMP workers and controlled local providers: immediate return alongside an independent tool, origin-end closure, two-client resolution, native steer and idle follow-up, restart recovery, lost acceptance response, and draft revision preservation. Separate Electron fixtures exercise card navigation, offline edits, reconnect, and explicit submission. These fixtures do not establish installed cross-device visual parity or replace real provider approval acceptance. Packaged native-window verification remains a separate gate.
