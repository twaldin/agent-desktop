import { expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import type { NativeForceToolAdmissionPort } from "./force-tool";
import { NativeForceToolAdmission } from "./force-tool-admission";
import { beginNativePrompt } from "./prompt";

const manager = () => ({
  onEntryAppended: undefined,
  async flush() {},
});

const controller = (capture: () => void): NativeForceToolAdmissionPort => ({
  getState: () => ({
    epoch: "worker", revision: 0, nativeSessionId: "session", model: null,
    availability: { state: "unsupported", reason: "fixture" }, tools: [], directives: [], canArm: false, canCancel: false,
  }),
  captureArm: () => { capture(); throw new Error("Force capture must not run for an invalid command identity."); },
  cancel: () => { throw new Error("Cancellation is outside this fixture."); },
  assertRecovery: () => { throw new Error("Recovery is outside this fixture."); },
});

test("ordinary admission preserves colon-bearing host command identities", async () => {
  const sessionManager = manager();
  const admission = new NativeForceToolAdmission(controller(() => {}), {
    sessionManager, prompt: async () => true,
  } as unknown as Pick<AgentSession, "sessionManager" | "prompt">, {
    commandId: "automation:run-id:prompt", commandVersion: 18,
  }, () => {});
  const run = admission.wrapRun(beginNativePrompt(sessionManager, async () => ({
    agentInvoked: false, handledCommand: "automation-flow",
  }), async () => {}, undefined, undefined, undefined, undefined, admission));
  await expect(run.accepted).resolves.toMatchObject({ kind: "native-command", command: "automation-flow" });
  await expect(run.completion).resolves.toBe(false);
  expect(run.forceToolReceipt).toBeUndefined();
});

test("an invalid force command identity is refused before native mutation", async () => {
  let captures = 0;
  const sessionManager = manager();
  const admission = new NativeForceToolAdmission(controller(() => { captures++; }), {
    sessionManager, prompt: async () => true,
  } as unknown as Pick<AgentSession, "sessionManager" | "prompt">, {
    commandId: "bad/identity", commandVersion: 18,
  }, () => {});
  const parsed = parseSlashCommand("/force read")!;
  const builtin = lookupBuiltinSlashCommand(parsed.name)!;
  await expect(admission.dispatch(parsed, builtin, () => builtin.handle!(parsed, {} as never), () => ""))
    .rejects.toThrow("Invalid native force-tool command identity");
  expect(captures).toBe(0);
});
