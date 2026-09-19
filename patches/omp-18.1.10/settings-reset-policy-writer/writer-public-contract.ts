import {
  Settings,
  type PersistedSettingsReadback,
  type PersistedSettingsSnapshot,
  type ResetPolicySettingPath,
  type ResetPolicySettingsWriter,
  type ResetPolicyWriterReadback,
} from "@oh-my-pi/pi-coding-agent/config/settings";

async function publicWriterContract(root: Settings, writer: ResetPolicySettingsWriter): Promise<void> {
  const enabled: ResetPolicySettingsWriter = await root.enableResetPolicyPersistence();
  const propagated = Settings.isolated({ "codexResets.autoRedeem": "unset" }, { resetPolicyWriter: enabled });
  const exactWriter: ResetPolicySettingsWriter | null = propagated.getResetPolicySettingsWriter();
  const path: ResetPolicySettingPath = "codexResets.salvageHorizonHours";
  propagated.set(path, 12);
  await propagated.flush();
  const readback: PersistedSettingsReadback = propagated.capturePersistedReadback([path]);
  const writerProof: ResetPolicyWriterReadback = readback.resetPolicyWriter;
  const snapshot: PersistedSettingsSnapshot = await readback.read();
  void [writer, exactWriter, writerProof, snapshot.overlay, snapshot.runtime];
}

// @ts-expect-error A partial object without the required targetId does not satisfy the public writer shape.
Settings.isolated({}, { resetPolicyWriter: { agentDir: "/tmp/agent" } });
// @ts-expect-error Reset-policy persistence accepts only the four exact schema paths.
const wrongPath: ResetPolicySettingPath = "theme";
void [publicWriterContract, wrongPath];
