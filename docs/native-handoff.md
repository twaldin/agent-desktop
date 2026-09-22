# Native handoff

The composer supports `/handoff [focus instructions]` through the existing generic command submission route. When the pinned builtin owns the name, OMP 18.1.10's headless handler summarizes the current session and compacts it **in place**. It does not create, fork, import, or navigate to another session.

## Discovery and dispatch

`apps/host/src/omp/composer-actions.ts` admits `handoff` as a supported native text handler rather than an unconnected identity transition. Both discovered and loaded-session catalogs already prefer the native `acpDescription`, which describes in-place compaction, over the TUI-oriented description about a new session. The native focus-instructions hint is retained. No desktop action, dialog, shared schema, or provider implementation is added.

`dispatchNativePrompt` keeps its existing order: exact loaded extension command, exact custom command, then the builtin. Shadowing commands remain their own operations; their text is not reinterpreted as native handoff. The ordinary composer request envelope is not ordinary model delivery: the builtin runs through its registered headless `handle`, not `session.prompt` or `handleTui`.

## Lifecycle and outcomes

- The dispatcher rejects commands during native compaction or abort cleanup, and rejects slash-command image attachments before effects. The native handler refuses streaming and an already-running handoff before calling `session.handoff`.
- Optional focus instructions go through native parsing to the original session. Native handoff owns model/credential checks, context preparation, generation, and the compaction entry. Its current-session identity and configured retained history are not replaced by desktop-created summaries or new-session operations.
- The existing dispatcher does not supply `runCommandInBackground`, so the handler is awaited inline, just like `/compact`. `beginNativePrompt` then awaits native persistence and session-manager flush before acknowledging the native command.
- Native refusal, cancellation, and failure text remains command output. A consumed-command receipt means the handler ran; it does **not** mean compaction succeeded. The native success output explicitly describes in-place compaction. Manual handoff does not advertise an automatically saved handoff file.
- Native `USER_INTERRUPT_LABEL` is consumed silently; an unreasoned cancellation produces cancellation output, and other failures remain visible. The current desktop worker interrupt does not attach that label: ordinary native `abort()` supplies `Handoff aborted by session`, which the pinned handler reports as `Handoff failed: Handoff aborted by session`. Stop must not be represented as necessarily silent or as a successful compaction.
- A post-handler persistence failure leaves admission unknown, preserving the existing original-submission identity contract. This change adds no retry, replay, receipt store, or session-switch logic. Stop, lost-response recovery, and owner/session correlation remain the existing command infrastructure's responsibility.

## Source-boundary evidence

The catalog regression fails against the unchanged 560cf9438f2aafeb2cf384e3b006d4b7cc68303a baseline because handoff is pending. After admission changes, focused catalog/command tests exercise the actual pinned registry, parser, headless handler, `beginNativePrompt`, and a native in-memory session journal. Controlled `AgentSession.handoff` boundaries cover inline waiting, original journal identity, extension/custom precedence, streaming/duplicate refusal, maintenance/abort/image fences, failure/cancellation output, the silent interrupt label, and unknown admission after persistence failure.

These controls do **not** prove native context generation or compaction: the handoff method is controlled, and the in-memory journal is not a disk-durability test. No App, worker, provider, reference application, retained profile, or native process runtime is launched for this source handoff.

Root's separate `handoff-native-root-001` prerequisite packet exercises the real pinned headless handler, native request builder, `SessionMaintenance`, and disk-backed `SessionManager` with canned in-process SSE and no network. Two seeded native prompts plus one handoff side request produce one compaction entry, preserve the session ID/file, and survive journal reopen. Baseline dispatch refuses handoff before any request. A nonexistent exact-model setup and too-small histories were preserved as failed attempts; native `keepRecentTokens: 1` provides the valid compaction cut in the successful fixture. This is native prerequisite evidence, not acceptance of the newly enabled desktop dispatcher or App/worker route.

Root integration acceptance must exercise an actual native session with sufficient history: one handoff compaction entry on the same session ID/file, native retained context and focus handling, real abort delivery, provider/precondition failures without false success, and receipt recovery after response loss/reopen without rerunning handoff. Existing `/compact`, `/shake`, and recovery behavior must remain intact. That integration evidence is separate from this bounded source proof.

Root current-source composition checks pass 42 tests/238 assertions, typecheck and build. A separate controlled-transport integration uses the newly enabled `dispatchNativePrompt` and `beginNativePrompt` with the actual native session: success commits one compaction and the persisted command output on the same session ID/file; a controlled HTTP failure commits no compaction and persists its failure output. These records survive native journal reopen. The first ordinary-abort probe incorrectly expected cancellation wording; its failed assertion and saved native abort output are retained. This exercises the command dispatcher and native persistence, not the complete App/host/worker transport or physical provider flow.

The corrected ordinary-abort check and the distinct `USER_INTERRUPT_LABEL` check both finish with zero compactions and unchanged session identity on reopen. Ordinary abort persists the native failure output; the explicit user-interrupt label adds no output entry. The final production bytes match the success/failure runs; only the private abort assertion changed. No operation is replayed to recover these recorded results.
