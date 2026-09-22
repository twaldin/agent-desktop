import { formatDuration } from "@oh-my-pi/pi-utils";
import type { TranscriptMessage } from "@agent-desktop/shared";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Display metadata from OMP async-result entries, never inferred from their text. */
export function backgroundJobNotice(message: Record<string, unknown>): TranscriptMessage["backgroundJobs"] {
  if ((message.role !== "custom" && message.role !== "hookMessage") || message.customType !== "async-result" || message.display !== true) return;
  const details = record(message.details);
  if (details?.jobs !== undefined && !Array.isArray(details.jobs)) return;
  const jobs: unknown[] = Array.isArray(details?.jobs) && details.jobs.length ? details.jobs : [details ?? {}];
  if (jobs.length > 256) return;
  const result: NonNullable<TranscriptMessage["backgroundJobs"]> = [];
  // Indexed iteration rejects holes rather than silently omitting rows.
  for (let index = 0; index < jobs.length; index++) {
    const job = record(jobs[index]); if (!job) return;
    const jobId = typeof job.jobId === "string" && job.jobId.length > 0 && job.jobId.length <= 256 ? job.jobId : "unknown";
    const type = job.type === "bash" || job.type === "task" || job.type === "eval" ? job.type : "job";
    const duration = typeof job.durationMs === "number" && Number.isFinite(job.durationMs) && job.durationMs >= 0 ? formatDuration(job.durationMs) : undefined;
    result.push({ jobId, type, ...(duration === undefined ? {} : { duration }) });
  }
  return result;
}
