import type { LocalEnvironmentExecutionOutput } from "@agent-desktop/shared";
import type { LocalEnvironmentPreparation, LocalEnvironmentPreparations } from "./preparations";
import { runLocalEnvironmentScript, type LocalEnvironmentRunInput, type LocalEnvironmentRunResult } from "./runner";

type RunStore = Pick<LocalEnvironmentPreparations, "get" | "getOutput" | "beginOutput" | "updateOutput">;

interface ActiveRun {
  revision: number;
  controller: AbortController;
  cancellationRequested: boolean;
  processSettled: boolean;
}

const maximumDurableOutputBytes = 8 * 1024 * 1024;

function utf8Prefix(value: Buffer, maximumBytes: number): string {
  let end = value.length;
  let text = value.toString("utf8");
  while (Buffer.byteLength(text) > maximumBytes && end > 0) {
    end -= Math.max(1, Buffer.byteLength(text) - maximumBytes);
    text = value.subarray(0, end).toString("utf8");
  }
  return text;
}

function snapshot(stdout: Buffer, stderr: Buffer): { stdout: string; stderr: string; encodingTruncated: boolean } {
  const stdoutText = utf8Prefix(stdout, maximumDurableOutputBytes);
  const remaining = maximumDurableOutputBytes - Buffer.byteLength(stdoutText);
  const stderrText = utf8Prefix(stderr, remaining);
  return {
    stdout: stdoutText,
    stderr: stderrText,
    encodingTruncated: Buffer.byteLength(stdoutText) < Buffer.byteLength(stdout.toString("utf8"))
      || Buffer.byteLength(stderrText) < Buffer.byteLength(stderr.toString("utf8")),
  };
}

/** Owns live process cancellation and durable, host-private output for one host. */
export class LocalEnvironmentRuns {
  private active = new Map<string, ActiveRun>();

  constructor(private store: RunStore) {}

  async run(record: LocalEnvironmentPreparation, input: LocalEnvironmentRunInput): Promise<LocalEnvironmentRunResult> {
    if (input.lifecycle !== "setup" && input.lifecycle !== "cleanup") throw new Error("Invalid local environment lifecycle.");
    const expectedPhase = input.lifecycle === "setup" ? "setup-running" : "cleanup-running";
    if (record.phase !== expectedPhase) throw new Error(`Cannot run ${input.lifecycle} while preparation is ${record.phase}.`);
    if (this.active.has(record.id)) throw new Error("This local-environment run is already active.");
    this.store.beginOutput(record, input.lifecycle);
    const controller = new AbortController();
    const active: ActiveRun = { revision: record.revision, controller, cancellationRequested: false, processSettled: false };
    this.active.set(record.id, active);
    const parentAbort = () => {
      if (!active.processSettled) this.requestCancellation(record.id, record.revision, active);
    };
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false;
    try {
      input.signal?.addEventListener("abort", parentAbort, { once: true });
      if (input.signal?.aborted) parentAbort();
      const result = await runLocalEnvironmentScript({
        ...input,
        signal: controller.signal,
        onProcessSettled: () => {
          active.processSettled = true;
          try { input.onProcessSettled?.(); } catch {}
        },
        onOutput: event => {
          const chunk = Buffer.from(event.chunk);
          const newlyTruncated = event.truncated && !truncated;
          if (event.stream === "stdout") stdout = Buffer.concat([stdout, chunk]);
          else stderr = Buffer.concat([stderr, chunk]);
          truncated ||= event.truncated;
          if (chunk.length || newlyTruncated) {
            const durable = snapshot(stdout, stderr);
            this.store.updateOutput(record.id, record.revision, current => ({
              ...current, sequence: current.sequence + 1,
              stdout: durable.stdout, stderr: durable.stderr, truncated: truncated || durable.encodingTruncated,
            }));
          }
          try { input.onOutput?.(event); } catch {}
        },
      });
      const durable = snapshot(Buffer.from(result.stdout), Buffer.from(result.stderr));
      this.store.updateOutput(record.id, record.revision, current => ({
        ...current, sequence: current.sequence + 1,
        stdout: durable.stdout, stderr: durable.stderr,
        truncated: result.outputTruncated || durable.encodingTruncated, finished: true,
      }));
      return result;
    } catch (error) {
      this.store.updateOutput(record.id, record.revision, current => ({ ...current, sequence: current.sequence + 1, finished: true }));
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", parentAbort);
      if (this.active.get(record.id) === active) this.active.delete(record.id);
    }
  }

  cancel(id: string, runRevision: number): boolean {
    const active = this.active.get(id);
    if (!active || active.revision !== runRevision || active.processSettled)
      throw new Error("This local-environment run is not active at that revision.");
    return this.requestCancellation(id, runRevision, active);
  }

  getOutput(id: string): LocalEnvironmentExecutionOutput | null {
    return this.store.getOutput(id);
  }

  private requestCancellation(id: string, runRevision: number, active: ActiveRun): boolean {
    if (active.cancellationRequested) return false;
    this.store.updateOutput(id, runRevision, current => ({
      ...current, sequence: current.sequence + 1, cancellationRequested: true,
    }));
    active.cancellationRequested = true;
    active.controller.abort();
    return true;
  }
}
