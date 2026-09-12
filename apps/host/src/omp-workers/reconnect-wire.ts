import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { deserialize, serialize } from "node:v8";

const MAX_FRAME = 32 * 1024 * 1024;

export interface WorkerReconnectEndpoint {
  version: 1;
  pid: number;
  instanceId: string;
  socketPath: string;
  token: string;
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
    private readonly receive: (value: unknown) => void, private readonly connected: () => unknown) {
    this.#server = server;
  }

  static async listen(input: { socketPath: string; token: string; instanceId: string }, receive: (value: unknown) => void,
    connected: () => unknown): Promise<WorkerReconnectServer> {
    if (!input.socketPath || !input.token || input.token.length < 32 || !/^[0-9a-f-]{36}$/.test(input.instanceId)) throw new Error("Invalid worker reconnect endpoint.");
    await mkdir(dirname(input.socketPath), { recursive: true, mode: 0o700 });
    await rm(input.socketPath, { force: true });
    let owner!: WorkerReconnectServer;
    const server = createServer(socket => owner.#accept(socket));
    owner = new WorkerReconnectServer({ version: 1, pid: process.pid, ...input }, server, receive, connected);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(input.socketPath, resolve); });
    await chmod(input.socketPath, 0o600);
    return owner;
  }

  #accept(socket: Socket): void {
    if (this.#closed || this.#socket) { socket.destroy(); return; }
    this.#socket = socket; this.#authenticated = false;
    receiveFrames(socket, value => {
      if (!this.#authenticated) {
        const auth = value as { type?: unknown; token?: unknown };
        if (auth?.type !== "auth" || auth.token !== this.endpoint.token) { socket.destroy(); return; }
        this.#authenticated = true;
        socket.write(frame(this.connected()));
        for (const queued of this.#queued) socket.write(queued);
        this.#queued = []; this.#queuedBytes = 0;
        return;
      }
      this.receive(value);
    }, () => undefined);
    socket.once("close", () => { if (this.#socket === socket) { this.#socket = undefined; this.#authenticated = false; } });
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
