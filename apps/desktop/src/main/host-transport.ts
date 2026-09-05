import type { NativeTerminalResult } from "@agent-desktop/shared";

export interface HostEndpoint { origin: string; hostId: string; token?: string }

export class HostRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message); this.name = "HostRequestError";
  }
}

/** Host resolution stays in the main process; credentials never cross the preload. */
export async function requestHost(endpoint: HostEndpoint, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${endpoint.origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000), redirect: "error",
  });
  const value = await response.json();
  if (!response.ok) {
    const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const error = object.error;
    const detail = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const message = typeof error === "string" ? error : typeof detail.message === "string" ? detail.message : undefined;
    const code = typeof object.code === "string" ? object.code : typeof detail.code === "string" ? detail.code : undefined;
    throw new HostRequestError(message || `Host request failed (${response.status}).`, response.status, code);
  }
  return value;
}

/** Electron does not preserve custom Error properties across both IPC boundaries. */
export async function nativeTerminalResult<T>(operation: () => Promise<T>): Promise<NativeTerminalResult<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) {
    return { ok: false, error: {
      message: error instanceof Error ? error.message : "The native terminal request failed.",
      ...(error instanceof HostRequestError ? { status: error.status, ...(error.code ? { code: error.code } : {}) } : {}),
    } };
  }
}
