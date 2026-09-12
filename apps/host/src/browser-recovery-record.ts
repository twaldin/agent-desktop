import { copyEvaluationBinding, evaluationKey, type BrowserEvaluationBinding } from "./omp-browser/evaluation-wire";
import type { WorkerReconnectEndpoint } from "./omp-workers/reconnect-wire";

export interface BrowserRecoveryRecord {
  version: 2;
  hostId: string;
  commandId: string;
  sessionId: string;
  ownerId: string;
  status: "arming" | "ready";
  source: WorkerReconnectEndpoint;
  destination: WorkerReconnectEndpoint;
  bindings: readonly BrowserEvaluationBinding[];
  recordedAt: number;
}

export function parseBrowserRecoveryRecord(value: unknown): BrowserRecoveryRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid browser recovery record.");
  const record = value as BrowserRecoveryRecord;
  const endpoint = (item: WorkerReconnectEndpoint) => item?.version === 1 && Number.isSafeInteger(item.pid) && item.pid > 0
    && typeof item.instanceId === "string" && /^[0-9a-f-]{36}$/.test(item.instanceId)
    && typeof item.socketPath === "string" && item.socketPath.length > 0 && item.socketPath.length <= 512
    && typeof item.token === "string" && /^[a-f0-9]{64}$/.test(item.token);
  if (record.version !== 2 || !record.hostId || !record.commandId || !record.sessionId || !record.ownerId || !["arming", "ready"].includes(record.status)
    || !endpoint(record.source) || !endpoint(record.destination) || !Array.isArray(record.bindings) || !record.bindings.length || record.bindings.length > 8
    || !Number.isFinite(record.recordedAt)) throw new Error("Invalid browser recovery record.");
  const bindings = record.bindings.map(copyEvaluationBinding);
  if (new Set(bindings.map(evaluationKey)).size !== bindings.length) throw new Error("Invalid browser recovery bindings.");
  return Object.freeze({ ...record, source: Object.freeze({ ...record.source }), destination: Object.freeze({ ...record.destination }), bindings: Object.freeze(bindings) });
}
