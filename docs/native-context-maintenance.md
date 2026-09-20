# Native context maintenance

The desktop command catalog exposes the pinned native `/compact` and `/shake` handlers when extension and custom-command precedence leave the builtin in control. The handlers retain OMP's argument parsing, provider selection, output text, history mutation, and command-output persistence.

`/compact` stays pending while the pinned native handler awaits compaction inline. Its native command receipt returns only after handler completion, native persistence, and the session-manager flush. The desktop Stop control remains callable during that pending command and sends a concurrent interrupt to the owned worker. The desktop reports the native result; an abort is not assumed silent because the current worker interrupt does not attach OMP's `USER_INTERRUPT_LABEL`. `/shake` rewrites the native session journal. The controlled App acceptance proves `/shake images` output remains visible after the host and App reopen the session; other modes are covered by native tests.

The Stop acceptance required no product correction: an initial coordinate-based harness click never dispatched `session.interrupt`; the corrected fixture activates the rendered App control and verifies the exact owning-session command before interpreting provider cancellation.

The controlled App acceptance fixture uses a disposable profile and a loopback provider. It does not contact a real provider or establish physical-input parity.
