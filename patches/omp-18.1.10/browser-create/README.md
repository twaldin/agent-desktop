# Native browser tab creation candidate

This candidate proves a direct browser resource action on a real OMP `AgentSession`. `createBrowserTabForSession` reads that session's live browser settings and native owner id, but does not invoke Eval, an agent tool call, approval hooks, or transcript writes.

The returned `targetDisposition` is deliberately explicit. Headless mode creates a page, cmux creates a surface, while configured CDP and relay modes adopt an existing target selected by OMP. Calling this operation in a connected or relay configuration must therefore never be described as creating a new browser page.

The managed tab name is admitted atomically in the native tab supervisor. A duplicate is a definite `BrowserTabCreateRejected`; failures after acquisition begins remain ordinary errors because their outcome may be unknown. Native session disposal retains responsibility for closing all owner tabs.

Run the isolated proof with:

```sh
bun patches/omp-18.1.10/browser-create/run-isolated.ts
```

The proof uses a copied pristine 18.1.10 package, the selected patch, an isolated OMP profile, and an existing Chrome for Testing binary. It makes no provider request and does not touch an existing browser profile.
