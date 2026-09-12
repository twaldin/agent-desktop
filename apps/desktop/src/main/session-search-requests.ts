/** One live search per native window and host. IDs fence late cleanup from
 * cancelling a replacement; renderer-supplied IDs cannot cancel another window. */
export class SessionSearchRequests {
  private current = new Map<number, Map<string, { id: string; controller: AbortController }>>();
  async run<T>(owner: number, hostId: string, id: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("Invalid chat search request identity.");
    const hosts = this.current.get(owner) ?? new Map();
    this.current.set(owner, hosts);
    hosts.get(hostId)?.controller.abort();
    const entry = { id, controller: new AbortController() };
    hosts.set(hostId, entry);
    try {
      const value = await operation(entry.controller.signal);
      entry.controller.signal.throwIfAborted();
      return value;
    } finally {
      if (hosts.get(hostId) === entry) hosts.delete(hostId);
      if (!hosts.size && this.current.get(owner) === hosts) this.current.delete(owner);
    }
  }
  cancel(owner: number, hostId: string, id: string): void {
    const entry = this.current.get(owner)?.get(hostId);
    if (entry?.id === id) entry.controller.abort();
  }
  close(owner: number): void {
    for (const entry of this.current.get(owner)?.values() ?? []) entry.controller.abort();
    this.current.delete(owner);
  }
}
