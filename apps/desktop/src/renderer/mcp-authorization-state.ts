import type { DesktopBridge, NativeMcpAuthorizationReply, NativeMcpAuthorizationSnapshot, NativeSessionMcpSnapshot } from '@agent-desktop/shared';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const active = (value: NativeMcpAuthorizationSnapshot | null) => value?.status === 'running' || value?.status === 'cancelling';
/** One owner-bound controller. Only opaque operation identities enter storage;
 * callback values are cleared by the input and sent once on a private route. */
export class McpAuthorizationState {
  value: NativeMcpAuthorizationSnapshot | null = null;
  error: string | null = null;
  loading = true;
  writing = false;
  pending: string | null = null;
  sent: { authorizationId: string; requestId: string } | null = null;
  #listeners = new Set<() => void>();
  #alive = true;
  #reading: number | null = null;
  #revision = 0;
  #lifetime = 0;
  #readAgain = false;
  #storageFailed = false;
  readonly #key: string;
  constructor(readonly bridge: DesktopBridge, readonly hostId: string, readonly sessionId: string, private storage: Storage) {
    this.#key = `mcp.authorization.${hostId}.${sessionId}`;
    try {
      this.pending = storage.getItem(this.#key);
      if (this.pending && !/^[a-zA-Z0-9_-]{1,200}$/.test(this.pending)) throw new Error();
      const raw = storage.getItem(`${this.#key}.response`);
      if (raw) {
        const value = JSON.parse(raw);
        if (!value || typeof value.authorizationId !== 'string' || typeof value.requestId !== 'string' || Object.keys(value).length !== 2) throw new Error();
        this.sent = value;
      }
    } catch { this.#storageFailed = true; this.error = 'The saved authorization receipt cannot be read. No authorization will be replayed.'; }
  }
  get supported() { return Boolean(this.bridge.getSessionMcpAuthorization && this.bridge.respondSessionMcpAuthorization && this.bridge.cancelSessionMcpAuthorization); }
  get responseBlocked() { return this.#storageFailed; }
  get busy() { return this.loading || this.writing || active(this.value) || Boolean(this.pending) || this.#storageFailed; }
  subscribe(listener: () => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  activate() { this.#alive = true; this.#revision++; }
  dispose() { this.#alive = false; this.#revision++; this.#lifetime++; this.#reading = null; this.#readAgain = false; this.writing = false; this.#listeners.clear(); }
  #emit() { if (this.#alive) for (const listener of this.#listeners) listener(); }
  #clear(key: string) {
    try { this.storage.removeItem(key); return true; }
    catch { this.#storageFailed = true; this.error = 'The authorization receipt could not be updated on this device.'; return false; }
  }
  async read() {
    if (!this.#alive || this.writing || !this.bridge.getSessionMcpAuthorization) { if (!this.supported) { this.loading = false; this.#emit(); } return; }
    if (this.#reading !== null) { this.#readAgain = true; return; }
    const revision = ++this.#revision;
    this.#reading = revision;
    try {
      const result = await this.bridge.getSessionMcpAuthorization(this.sessionId, this.hostId, this.pending ?? undefined);
      if (!this.#alive || revision !== this.#revision) return;
      this.value = result.value;
      if (!this.#storageFailed) this.error = result.unavailable ?? null;
      const receipt = result.receipt;
      if (this.pending) {
        if (result.value?.commandId === this.pending || receipt?.state === 'succeeded' || receipt?.state === 'failed') {
          if (this.#clear(this.#key)) this.pending = null;
          if (receipt?.state === 'failed') this.error = receipt.message ?? 'The original authorization start failed.';
        } else this.error = receipt?.state === 'pending' ? 'Waiting for the original authorization start.' : 'The original authorization start is unconfirmed. It has not been replayed.';
      }
      // A current native snapshot can prove this prompt was consumed. An
      // unavailable worker cannot, so keep its receipt across disconnection.
      if (this.sent && result.value && (this.sent.authorizationId !== result.value.authorizationId || !active(result.value) || !result.value.login.prompts.some(prompt => prompt.requestId === this.sent!.requestId))) {
        if (this.#clear(`${this.#key}.response`)) this.sent = null;
      }
    } catch { if (this.#alive && revision === this.#revision) this.error = 'Authorization state could not be read. Reconnect to the owning host and check the original attempt.'; }
    finally { if (this.#reading === revision) this.#reading = null; if (this.#alive && revision === this.#revision) { this.loading = false; this.#emit(); } if (this.#alive && this.#readAgain && this.#reading === null) { this.#readAgain = false; void this.read(); } }
  }
  async start(snapshot: NativeSessionMcpSnapshot, serverName: string) {
    if (!this.#alive || !this.supported || this.busy || !snapshot.available || !snapshot.servers.some(server => server.name === serverName && server.canAuthorize)) return;
    const id = crypto.randomUUID(), lifetime = this.#lifetime;
    try { this.storage.setItem(this.#key, id); } catch { this.#storageFailed = true; this.error = 'Cannot preserve an authorization receipt. Nothing was sent.'; this.#emit(); return; }
    this.pending = id; this.writing = true; this.#revision++; this.#reading = null; this.error = null; this.#emit();
    try {
      const result = await this.bridge.command({id, command: {type: 'session.mcp.authorize', hostId: this.hostId, sessionId: this.sessionId, epoch: snapshot.epoch, expectedRevision: snapshot.revision, serverName}}, this.hostId);
      if (!this.#alive || lifetime !== this.#lifetime) return;
      if (result.commandId !== id || !result.ok) this.error = 'The authorization start needs a receipt check. It will not be replayed.';
    } catch { if (this.#alive && lifetime === this.#lifetime) this.error = 'The authorization start may have reached the host. Checking its original receipt.'; }
    finally { if (this.#alive && lifetime === this.#lifetime) { this.writing = false; this.#emit(); void this.read(); } }
  }
  async respond(reply: NativeMcpAuthorizationReply) {
    if (!this.#alive || this.writing || this.#storageFailed || !this.bridge.respondSessionMcpAuthorization || this.value?.authorizationId !== reply.authorizationId || !active(this.value) || this.value.status === 'cancelling' || !this.value.login.prompts.some(prompt => prompt.requestId === reply.requestId) || Boolean(this.sent)) return;
    const identity = { authorizationId: reply.authorizationId, requestId: reply.requestId };
    try { this.storage.setItem(`${this.#key}.response`, JSON.stringify(identity)); } catch { this.#storageFailed = true; this.error = 'Cannot preserve the response receipt. Nothing was sent.'; this.#emit(); return; }
    this.sent = identity;
    await this.#write(() => this.bridge.respondSessionMcpAuthorization!(this.sessionId, reply, this.hostId));
  }
  async cancel() {
    if (!this.#alive || this.writing || !this.bridge.cancelSessionMcpAuthorization || !this.value || !active(this.value) || this.value.status === 'cancelling') return;
    const id = this.value.authorizationId;
    await this.#write(() => this.bridge.cancelSessionMcpAuthorization!(this.sessionId, id, this.hostId));
  }
  async #write(send: () => Promise<unknown>) {
    const lifetime = this.#lifetime;
    this.writing = true; this.#revision++; this.#reading = null; this.error = null; this.#emit();
    try { await send(); }
    catch { if (this.#alive && lifetime === this.#lifetime) this.error = 'The response needs a status check. It will not be sent again automatically.'; }
    finally { if (this.#alive && lifetime === this.#lifetime) { this.writing = false; this.#emit(); void this.read(); } }
  }
}
