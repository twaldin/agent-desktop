# Native forced-tool requests

The Force next tool control prepares OMP's original `/force <tool> [prompt]` command in the composer. Choosing a tool does not send a prompt. The host's current native tool registry, model, API and construction dialect determine availability. Native routes that accept forcing with limitations remain available with their caveats; unsupported native routes explain the refusal.

Typed commands, including `/force:<tool> [prompt]`, use native command parsing and exact extension/custom-command precedence. The picker supplies a current worker epoch and policy revision; typing a command does not invent a prepared selection. A new conversation first creates its actual owning session and loads that session's command catalog before dispatch.

## Queue and delivery

OMP owns the runnable queue. The app observes original directive identities and the native named-tool then `none` sequence. It does not persist a tool-choice override, reconstruct a queue on restart or replace native FIFO order. A completed request does not prove that the provider executed the requested tool. Opaque native work ahead of a force directive remains ahead of it.

The queue display distinguishes pending tool, tool request in progress, pending final response and final-response request in progress. A native retry retains the directive identity. Removing a pending directive uses its original worker epoch, revision and ID; it cannot remove an in-flight request or recreate a retired worker. Reads are authenticated and do not create workers.

Command protocol 18 and worker protocol 58 carry bounded state and receipts. The existing host command journal owns deduplication. Lost cancellation or submission acknowledgements retain the original operation ID for reconciliation; checking an operation does not create another arm. Historic receipts remain separate from the live worker queue.

## Partial failures

Arming and recording an optional prompt are separate outcomes. If the original arm is known but the prompt was not entered, the app may offer Send remaining prompt. The host checks the original failed journal entry, exact remaining plain text, model/thinking/permission selections and the same live directive. Native admission checks current ownership and policy again immediately before entering the prompt. Recovery never adds another force directive or replaces newer composer edits.

Once the native prompt has been entered, a missing user-message entry does not prove that nothing happened: a native command or extension may already have acted. Such an outcome remains unknown and cannot become replay-safe merely because another error wrapper observes no entry. A worker restart, changed owner, missing directive, uncertain arm or unknown journal result does not authorize recovery. Attached prompts are outside this plain-text recovery path.

## Evidence boundary

This integration is under validation. Controlled tests, isolated native request-builder experiments and the production App acceptance runner have distinct scopes. The runner uses a disposable host and actual native tools with a loopback HTTP provider; those responses do not establish vendor acceptance, account switching, cross-device behavior, installed-artifact acceptance or reference appearance. Independent source review and the complete GOAL.md acceptance matrix remain separate gates.
