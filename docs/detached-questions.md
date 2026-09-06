# Detached structured questions

The app adds `ask_async` through an OMP extension while preserving native blocking `ask` and interactive approvals. It accepts one to three structured questions, records them in the native session journal, returns immediately, and lets the original turn continue. An unanswered question closes when its originating turn ends; reopening after worker loss repairs an unmatched open entry as closed.

The composer card supports option choices, free text, Previous/Next, Skip and Dismiss. Choices are drafts, never implicit submissions. Cached open questions remain editable offline; Send requires reconnection. Answer drafts use the existing owning-host revision and conflict mechanism. A submitted revision is cleared only after a verified acceptance; newer edits remain intact.

## Acceptance and delivery are separate

`session.question.answer` carries the native question entry, canonical answers, submitted draft revision and existing command identity. The owning host orders the command and OMP reserves the question synchronously before flushing acceptance. Competing clients cannot both resolve it. A worker response lost after acceptance is reported as unknown. A durable native snapshot can reconcile that exact command and draft revision; an in-memory entry with a failed flush cannot establish acceptance.

Accepted answers wait durably until their host is eligible to deliver. An ordinary unsent conversation draft, archive, interruption or pending native interaction holds delivery. The answer becomes one ordinary native user message through steer during a running turn or follow-up while idle. Admission and turn completion are tracked separately, so Stop and other host commands remain responsive while a native tool runs. A delivery attempt without a durable result is shown as unknown and is not replayed automatically.

The native journal is authoritative. `questionDeliveryPending` is only a persisted scheduler wake-up hint. Question observations validate owning host and session identity in the main-process transport and cache. Credentials remain in the owning host transport.

## Evidence boundary

Source tests exercise real OMP workers and controlled local providers: immediate return alongside an independent tool, origin-end closure, two-client resolution, native steer and idle follow-up, restart recovery, lost acceptance response, and draft revision preservation. Separate Electron fixtures exercise card navigation, offline edits, reconnect, and explicit submission. These fixtures do not establish installed cross-device visual parity or replace real provider approval acceptance. Packaged native-window verification remains a separate gate.

## Compact card follow-up

The next source batch places the alternative response beside Skip/Next, uses a single-line free-text field that grows for longer answers, restores regular muted header text, and uses the pinned question and pencil artwork. A single-choice selection and its alternative text replace one another when edited; multi-select questions retain combined selections and text. Offline, conflict and uncertain-delivery behavior remains unchanged.

Controlled Electron checks at 736-point card width record a 222-point choice card and 186-point free-text card, plus long-answer editing at a 368-point width. They exercise replacement in both directions, offline navigation/editing, reconnect and exactly one submitted answer envelope. Typecheck and 15 scoped question/submission/parser tests pass. Private captures and geometry are in `.data/question-card-compact-21-final/`. These are component checks; exact fonts, hover/selected states, whole-window registration and packaged Work verification remain open. Release20.1 is immutable and does not contain this follow-up.

## Underlying composer follow-up

The source after21 collapses an empty, unfocused ordinary composer to one row while a detached question is displayed. The image-add, model, native permission and Stop controls remain available. Focusing the prompt, typing an ordinary draft, attaching images, or showing an attachment notice keeps the full composer. Panes below600 points retain the wrapping layout. The visibility rule does not change answer delivery, ordinary draft state, Stop, or approval semantics.

The full production App with controlled transport at1440×1000 measures44 points collapsed and106 points focused, retains a natively typed ordinary draft after blur, and hit-tests Stop in both layouts. Nine workflow groups/nine captured views pass in `.data/question-composer22-production-final/`; five actual-input model-menu views pass in `.data/power22-controls-reviewed-final/`, including models without reasoning options. Typecheck passes. These results are source verification, not installed22 acceptance or matched-pixel parity. The earlier hidden-window focus attempt is retained as a failed harness run; the corrected run explicitly focuses Electron webContents before testing CSS focus behavior.
