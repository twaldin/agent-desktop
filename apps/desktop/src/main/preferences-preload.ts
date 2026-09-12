import { parsePreferencesSnapshotV2, type PreferencesV2ReadResult } from "../../../../packages/shared/src/preferences-v2";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preferences v2 response.");
  return value as Record<string, unknown>;
}

/** Parse the IPC envelope before it reaches the renderer application state. */
export function createPreferencesV2Bridge(invoke: (channel: string) => Promise<unknown>): () => Promise<PreferencesV2ReadResult> {
  return async () => {
    const result = object(await invoke("host:preferences-v2"));
    if (result.ok === true && Object.keys(result).length === 2 && Object.hasOwn(result, "value")) {
      return { ok: true, value: parsePreferencesSnapshotV2(result.value) };
    }
    if (result.ok === false && Object.keys(result).length === 2 && Object.hasOwn(result, "error")) {
      const error = object(result.error);
      if (typeof error.message !== "string" || !error.message || Object.keys(error).some(key => key !== "message" && key !== "status" && key !== "code")
        || (Object.hasOwn(error, "status") && (!Number.isInteger(error.status) || (error.status as number) < 100 || (error.status as number) > 599))
        || (Object.hasOwn(error, "code") && (typeof error.code !== "string" || !error.code))) throw new Error("Invalid preferences v2 error response.");
      return { ok: false, error: { message: error.message, ...(typeof error.status === "number" ? { status: error.status } : {}), ...(typeof error.code === "string" ? { code: error.code } : {}) } };
    }
    throw new Error("Invalid preferences v2 response.");
  };
}
