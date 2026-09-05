import type { NativeTerminalBridge, NativeTerminalResult } from "../../../../packages/shared/src/terminals";

export type NativeTerminalClient = { [Key in keyof NativeTerminalBridge]: NativeTerminalBridge[Key] extends (...args: infer Args) => Promise<NativeTerminalResult<infer Value>> ? (...args: Args) => Promise<Value> : NativeTerminalBridge[Key] };
export class NativeTerminalTransportError extends Error {
  constructor(error: { message: string; status?: number; code?: string }) { super(error.message); this.name = "NativeTerminalTransportError"; this.status = error.status; this.code = error.code; }
  readonly status?: number;
  readonly code?: string;
}
export function unwrapNativeTerminalResult<T>(result: NativeTerminalResult<T>): T {
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") throw new Error("The desktop returned an invalid native terminal response.");
  if (!result.ok) throw new NativeTerminalTransportError(result.error);
  return result.value;
}
const clients = new WeakMap<NativeTerminalBridge, NativeTerminalClient>();
/** IPC error envelopes are unwrapped once; codes survive Electron's Error serialization. */
export function nativeTerminalClient(bridge: NativeTerminalBridge): NativeTerminalClient {
  const existing = clients.get(bridge); if (existing) return existing;
  const client: NativeTerminalClient = {
    getNativeTerminalCapabilities: async host => unwrapNativeTerminalResult(await bridge.getNativeTerminalCapabilities(host)),
    nativeTerminalQuery: async (query, host) => unwrapNativeTerminalResult(await bridge.nativeTerminalQuery(query, host)),
    nativeTerminalAction: async (action, host) => unwrapNativeTerminalResult(await bridge.nativeTerminalAction(action, host)),
    writeNativeTerminal: async (input, host) => unwrapNativeTerminalResult(await bridge.writeNativeTerminal(input, host)),
    subscribeNativeTerminals: listener => bridge.subscribeNativeTerminals(listener),
  };
  clients.set(bridge, client); return client;
}
