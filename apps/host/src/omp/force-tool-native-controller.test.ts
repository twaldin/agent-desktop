import { expect, test } from "bun:test";
import { runForceNativeFixture } from "./fixtures/force-native-subprocess";

test("real native session force receipts, current ownership, recovery and nonreplay", async () => {
  const result = await runForceNativeFixture("force-native-controller.ts");
  expect("covered" in result && result.covered).toEqual(expect.arrayContaining([
    "original-handler-synchronous-arm-independent-async-output-rejection", "real-active-extension",
    "native-unavailable-drop", "registry-stale-ticket", "atomic-recovery-current-idle-fence",
    "recovery-preserves-opaque-earlier-and-native-force-FIFO", "exact-replayed-cancel",
    "reentrant-ambiguity-no-rollback", "synchronous-after-arm-error-receipt", "same-model-compat-ticket-change",
    "actual-env-dialect-change-degraded-still-native-allowed", "original-owner-change",
    "worker-reconstruction-new-epoch-history-never-replays", "three-google-original-setter-rejections",
    "remaining-api-original-setter-rejections", "own-preflight-external-read-does-not-stale-capture-or-recovery", "real-active-mcp",
    "definite-usage-missing-tool-stale-guard-not-armed", "definite-busy-not-armed", "nested-original-handler-capture-unknown",
  ]));
}, 120_000);
