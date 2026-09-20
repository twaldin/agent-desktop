# Native reset pass context

`createNativeResetPassContextFactory` captures one native pass from the exact `CodexResetPolicySessionBinding`. It retains the original session, Settings, registry and AuthStorage objects, a synchronous Settings observation, the native credential-selection observation, and every original reset-account proof before the first await.

Planning binds actions in their native order to those pre-I/O proofs. Decision binding uses `OmpInteractionBridge.runWithDecisionBinding` and checks continuity after the native answer settles. Persistence adopts only the native one-shot auto-redeem write, flushes the original Settings writer and verifies fresh persisted layers. Admission refreshes credits through the same session without selecting a replacement; the final synchronous consume guard checks both observations and the original account proof.

The context owns only its observation and session listener. It does not enable policy, create authority, recover workers, contact providers by itself, or dispose borrowed Settings/AuthStorage objects.

Decision presentation composes the original native callback signal through `OmpInteractionBridge.runWithSignal` around the existing one-select binding scope. An already-aborted signal publishes nothing; aborting a held selection resolves that exact UI request as cancelled and prevents a late answer. Callers without a signal keep the original binding behavior. The runtime owner factory forwards both scopes through its original bridge lookup and fails closed while that bridge is unavailable.

Credit choice delegates to pi-ai's exported `pickSoonestExpiringCredit`, the same helper used by native reset consumption: available dated credits sort by earliest expiry, available undated credits follow, and if none are marked available the first backend credit is returned so the backend can report its real business outcome. The context does not implement a second selector.
