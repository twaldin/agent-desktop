import { validBrowserFrameTarget, type BrowserFrameTarget } from "@agent-desktop/shared";
import { serialize } from "node:v8";

export interface BrowserEvaluationBinding extends BrowserFrameTarget {
  ownerId: string;
  operationId: string;
  backend: "cdp" | "cmux";
}
export type BrowserEvaluationFrame = { type: "worker-cdp"; channel: string } & (
  | { kind: "data"; sequence: number; data: string }
  | { kind: "ack"; sequence: number }
  | { kind: "close"; errors?: string[] }
  | { kind: "drained"; errors: string[] }
);
export interface BrowserCdpDescriptor {
  version: 1; channel: string; targetId: string; activateForScreenshot: boolean; dialogs?: "accept" | "dismiss";
}
export interface BrowserCmuxState {
  version: 1; surfaceId: string; url: string; title?: string;
  viewport: { width: number; height: number; deviceScaleFactor?: number };
  elementRefs: Array<{ id: number; ref: string; name?: string; role?: string }>;
}
export type BrowserEvaluationDescriptor = { binding: BrowserEvaluationBinding } & (
  | { backend: "cdp"; descriptor: BrowserCdpDescriptor }
  | { backend: "cmux"; state: BrowserCmuxState }
);
export interface NativeCdpEvaluation {
  readonly descriptor: Readonly<BrowserCdpDescriptor>;
  start(post: (frame: BrowserEvaluationFrame) => void): void;
  receive(frame: BrowserEvaluationFrame): void;
  dispose(): Promise<void>;
}
export interface NativeCmuxEvaluation {
  readonly state: Readonly<BrowserCmuxState>;
  request(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
}
export type BrowserEvaluationOperation =
  | { operation: "openBrowserEvaluation"; args: { binding: BrowserEvaluationBinding; timeoutMs: number } }
  | { operation: "startBrowserEvaluation" | "disposeBrowserEvaluation"; args: { binding: BrowserEvaluationBinding } }
  | { operation: "inspectOpenBrowserEvaluation"; args: { binding: BrowserEvaluationBinding } }
  | { operation: "inspectRetainedBrowserEvaluation"; args: { binding: BrowserEvaluationBinding } }
  | { operation: "requestBrowserEvaluation"; args: { binding: BrowserEvaluationBinding; sequence: number; method: string; params: Record<string, unknown>; options?: { timeoutMs?: number } } };

const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
export function copyEvaluationBinding(value: BrowserEvaluationBinding): BrowserEvaluationBinding {
  if (!validBrowserFrameTarget(value) || !identity(value.ownerId) || !identity(value.operationId) || !["cdp", "cmux"].includes(value.backend)) throw new Error("Invalid original browser evaluation binding.");
  return { workerPid: value.workerPid, name: value.name, targetId: value.targetId, ownerId: value.ownerId, operationId: value.operationId, backend: value.backend };
}
export function evaluationKey(value: BrowserEvaluationBinding): string {
  const b = copyEvaluationBinding(value);
  return JSON.stringify([b.ownerId, b.workerPid, b.name, b.targetId, b.operationId, b.backend]);
}
/** A bounded owned IPC copy, not a JSON conversion or a method projection. */
export function copyEvaluationValue<T>(value: T): T {
  if (serialize(value).byteLength > 16 * 1024 * 1024) throw new Error("Browser evaluation IPC payload exceeded 16 MiB.");
  return structuredClone(value);
}
export function copyEvaluationFrame(value: BrowserEvaluationFrame, channel?: string): BrowserEvaluationFrame {
  if (!value || value.type !== "worker-cdp" || !identity(value.channel) || channel !== undefined && channel !== value.channel) throw new Error("Invalid original CDP channel frame.");
  if (value.kind === "data" || value.kind === "ack") {
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.kind === "data" && typeof value.data !== "string") throw new Error("Invalid CDP frame sequence or payload.");
  } else if (value.kind === "close" || value.kind === "drained") {
    if (value.kind === "drained" || value.errors !== undefined) {
      if (!Array.isArray(value.errors) || value.errors.length > 256) throw new Error("Invalid CDP drain errors.");
      for (let i = 0; i < value.errors.length; i++) if (typeof value.errors[i] !== "string" || value.errors[i]!.length > 4096) throw new Error("Invalid CDP drain error.");
    }
  } else throw new Error("Invalid CDP control kind.");
  const base = { type: "worker-cdp" as const, channel: value.channel };
  if (value.kind === "data") {
    if (Buffer.byteLength(value.data, "utf8") > 16 * 1024 * 1024) throw new Error("CDP frame exceeded native byte capacity.");
    return { ...base, kind: "data", sequence: value.sequence, data: value.data };
  }
  if (value.kind === "ack") return { ...base, kind: "ack", sequence: value.sequence };
  if (value.kind === "drained") return { ...base, kind: "drained", errors: [...value.errors] };
  return { ...base, kind: "close", ...(value.errors === undefined ? {} : { errors: [...value.errors] }) };
}
export function copyEvaluationDescriptor(value: BrowserEvaluationDescriptor, binding: BrowserEvaluationBinding): BrowserEvaluationDescriptor {
  if (!value || evaluationKey(value.binding) !== evaluationKey(binding) || value.backend !== binding.backend) throw new Error("Browser evaluation returned a different original binding.");
  if (value.backend === "cdp") {
    const d = value.descriptor;
    if (!d || d.version !== 1 || !identity(d.channel) || d.targetId !== binding.targetId || typeof d.activateForScreenshot !== "boolean"
      || d.dialogs !== undefined && d.dialogs !== "accept" && d.dialogs !== "dismiss") throw new Error("Invalid retained CDP descriptor.");
  } else {
    const s = value.state;
    if (!s || s.version !== 1 || s.surfaceId !== binding.targetId || typeof s.url !== "string" || s.title !== undefined && typeof s.title !== "string"
      || !s.viewport || !Number.isFinite(s.viewport.width) || !Number.isFinite(s.viewport.height)
      || s.viewport.deviceScaleFactor !== undefined && !Number.isFinite(s.viewport.deviceScaleFactor) || !Array.isArray(s.elementRefs)) throw new Error("Invalid retained cmux state.");
    const ids = new Set<number>();
    for (let i = 0; i < s.elementRefs.length; i++) {
      const ref = s.elementRefs[i];
      if (!ref || !Number.isSafeInteger(ref.id) || ref.id < 0 || ref.ref !== `@e${ref.id}` || ids.has(ref.id) || ref.name !== undefined && typeof ref.name !== "string" || ref.role !== undefined && typeof ref.role !== "string") throw new Error("Invalid retained cmux reference.");
      ids.add(ref.id);
    }
  }
  return copyEvaluationValue(value);
}
