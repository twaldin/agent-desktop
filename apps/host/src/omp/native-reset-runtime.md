# OMP native reset owner lifecycle

`NativeResetRuntimeOwners` adapts the synchronous SDK owner factory to one OMP root session. The first binding must contain the exact root Settings, ModelRegistry and AuthStorage. Every child binding must be internally exact for its actual SDK session and retain the root's opaque borrowed Settings writer; task, vibe and revived children may otherwise have distinct Settings, registry and auth objects. No session ID lookup is used.

Decision UI delegates only to the root session's installed `OmpInteractionBridge` and fails while that bridge is unavailable. On disposal, OMP calls `beginClose()` on every owner before native teardown and waits for native callbacks and child settlement before calling any `finish()`. This ordering matters because `NativeResetChannelOwner.finish()` finishes its channel: every sibling has already stopped dispatching before the first channel can finish. Durable host authority remains outside this helper.

The SDK exposes no child-session disposal notification to this factory. The group therefore retains lifecycle owners until root disposal, capped at 128; further owner creation fails closed. Callback wrappers track every in-flight native owner call independently of SDK teardown, so a rejected native dispose cannot let owner/channel finish over a live callback.

Once terminal finish begins, newly invoked SDK callbacks reject before reaching an owner. Finish first waits for group-wide callback quiescence, then invokes every owner finish independently; an early sibling can never finish a shared channel while another sibling callback remains held. Raw JavaScript cleanup throws, including `undefined`, are retained as actual failures.
