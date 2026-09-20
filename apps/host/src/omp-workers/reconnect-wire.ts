import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { deserialize, serialize } from "node:v8";

const MAX_FRAME = 32 * 1024 * 1024;
const MAX_RESET_IDENTIFIER = 512;
const MAX_RESET_PATH = 4_096;
const INSTANCE_ID = /^[0-9a-f-]{36}$/;

/** The original reset-policy binding recorded when the owning host admitted the
 * worker. It is persisted and replayed verbatim: a reconnecting host never mints
 * a new epoch, and a missing binding means the ordinary ownerless endpoint. */
export type WorkerResetPolicyReconnect = Readonly<{ workerEpoch: string; rootSessionId: string; sessionFile: string; cwd: string }>;

export interface WorkerReconnectEndpoint {
  version: 1;
  pid: number;
  instanceId: string;
  socketPath: string;
  token: string;
  resetPolicy?: WorkerResetPolicyReconnect;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

/** Validates a reset-policy reconnect binding and returns a frozen whitelist copy.
 * Any present-but-malformed binding throws; it never degrades to ownerless. */
export function parseWorkerResetPolicyReconnect(value: unknown): WorkerResetPolicyReconnect {
  const input = value as Partial<Record<keyof WorkerResetPolicyReconnect, unknown>> | null;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !boundedString(input.workerEpoch, MAX_RESET_IDENTIFIER) || !boundedString(input.rootSessionId, MAX_RESET_IDENTIFIER)
    || !boundedString(input.sessionFile, MAX_RESET_PATH) || !isAbsolute(input.sessionFile)
    || !boundedString(input.cwd, MAX_RESET_PATH) || !isAbsolute(input.cwd))
    throw new Error("Invalid worker reset-policy reconnect binding.");
  return Object.freeze({ workerEpoch: input.workerEpoch, rootSessionId: input.rootSessionId, sessionFile: input.sessionFile, cwd: input.cwd });
}

export function sameWorkerResetPolicyReconnect(expected: WorkerResetPolicyReconnect, actual: WorkerResetPolicyReconnect): boolean {
  return expected.workerEpoch === actual.workerEpoch && expected.rootSessionId === actual.rootSessionId
    && expected.sessionFile === actual.sessionFile && expected.cwd === actual.cwd;
}

/** Whitelist-copies an already shape-checked endpoint, validating and freezing the
 * nested reset binding when present. Ownerless endpoints carry no `resetPolicy` key. */
export function copyWorkerReconnectEndpoint(endpoint: WorkerReconnectEndpoint): WorkerReconnectEndpoint {
  const copy: WorkerReconnectEndpoint = { version: 1, pid: endpoint.pid, instanceId: endpoint.instanceId, socketPath: endpoint.socketPath, token: endpoint.token };
  if (endpoint.resetPolicy !== undefined) copy.resetPolicy = parseWorkerResetPolicyReconnect(endpoint.resetPolicy);
  return Object.freeze(copy);
}

function frame(value: unknown): Buffer {
  const body = serialize(value);
  if (body.byteLength > MAX_FRAME) throw new Error("Worker reconnect frame exceeded 32 MiB.");
  const header = Buffer.allocUnsafe(4); header.writeUInt32BE(body.byteLength);
  return Buffer.concat([header, body]);
}

function receiveFrames(socket: Socket, receive: (value: unknown) => void, failed: (error: unknown) => void): void {
  let buffered = Buffer.alloc(0);
  socket.on("data", chunk => {
    try {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.byteLength >= 4) {
        const length = buffered.readUInt32BE(0);
        if (length > MAX_FRAME) throw new Error("Worker reconnect frame exceeded 32 MiB.");
        if (buffered.byteLength < length + 4) return;
        const body = buffered.subarray(4, length + 4); buffered = buffered.subarray(length + 4);
        receive(deserialize(body));
      }
    } catch (error) { failed(error); socket.destroy(); }
  });
  socket.on("error", failed);
}

export class WorkerReconnectServer {
  readonly #server: Server;
  #socket?: Socket;
  #closed = false;
  #authenticated = false;
  #queued: Buffer[] = [];
  #queuedBytes = 0;

  private constructor(readonly endpoint: WorkerReconnectEndpoint, server: Server,
    private readonly receive: (value: unknown) => void, private readonly recovered: () => unknown,
    private readonly disconnected?: () => void) {
    this.#server = server;
  }

  /** `recovered` builds the first frame every authenticated owner receives, ahead of
   * any queued backlog. `disconnected` fires once per authenticated owner whose
   * transport closed while the endpoint is still open; rejected peers and the
   * server's own close never fire it. */
  static async listen(input: { socketPath: string; token: string; instanceId: string; resetPolicy?: WorkerResetPolicyReconnect },
    receive: (value: unknown) => void, recovered: () => unknown, disconnected?: () => void): Promise<WorkerReconnectServer> {
    if (!input.socketPath || !input.token || input.token.length < 32 || !INSTANCE_ID.test(input.instanceId)) throw new Error("Invalid worker reconnect endpoint.");
    const endpoint = copyWorkerReconnectEndpoint({ version: 1, pid: process.pid, instanceId: input.instanceId, socketPath: input.socketPath, token: input.token, resetPolicy: input.resetPolicy });
    await mkdir(dirname(input.socketPath), { recursive: true, mode: 0o700 });
    await rm(input.socketPath, { force: true });
    let owner!: WorkerReconnectServer;
    const server = createServer(socket => owner.#accept(socket));
    owner = new WorkerReconnectServer(endpoint, server, receive, recovered, disconnected);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(input.socketPath, resolve); });
    await chmod(input.socketPath, 0o600);
    return owner;
  }

  /** True only while an authenticated owner holds the live transport. */
  get connected(): boolean { return this.#authenticated && this.#socket !== undefined && !this.#socket.destroyed; }

  #accept(socket: Socket): void {
    if (this.#closed || this.#socket) { socket.destroy(); return; }
    this.#socket = socket; this.#authenticated = false;
    receiveFrames(socket, value => {
      if (!this.#authenticated) {
        const auth = value as { type?: unknown; token?: unknown };
        if (auth?.type !== "auth" || auth.token !== this.endpoint.token) { socket.destroy(); return; }
        this.#authenticated = true;
        socket.write(frame(this.recovered()));
        for (const queued of this.#queued) socket.write(queued);
        this.#queued = []; this.#queuedBytes = 0;
        return;
      }
      this.receive(value);
    }, () => undefined);
    socket.once("close", () => {
      if (this.#socket !== socket) return;
      const lost = this.#authenticated;
      this.#socket = undefined; this.#authenticated = false;
      if (lost && !this.#closed) this.disconnected?.();
    });
  }

  send(value: unknown): void {
    const encoded = frame(value);
    if (this.#socket && this.#authenticated) { this.#socket.write(encoded); return; }
    if (this.#queuedBytes + encoded.byteLength > MAX_FRAME) throw new Error("Worker reconnect backlog exceeded 32 MiB.");
    this.#queued.push(encoded); this.#queuedBytes += encoded.byteLength;
  }

  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true;
    this.#socket?.destroy();
    await new Promise<void>(resolve => this.#server.close(() => resolve()));
    await rm(this.endpoint.socketPath, { force: true });
  }
}

export async function connectWorkerEndpoint(endpoint: WorkerReconnectEndpoint,
  receive: (value: unknown) => void, disconnected: (error?: unknown) => void): Promise<{ send(value: unknown): void; close(): void }> {
  if (endpoint.version !== 1 || !Number.isSafeInteger(endpoint.pid) || endpoint.pid < 1 || !endpoint.instanceId
    || !endpoint.socketPath || endpoint.token.length < 32)
    throw new Error("Invalid worker reconnect endpoint.");
  const socket = createConnection(endpoint.socketPath);
  let reported=false;
  const report=(error?:unknown)=>{if(reported)return;reported=true;disconnected(error);};
  receiveFrames(socket, receive, report);
  socket.once("close",()=>report());
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(frame({ type: "auth", token: endpoint.token }));
  return { send: value => socket.write(frame(value)), close: () => socket.destroy() };
}
