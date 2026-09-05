/** Admission barrier after a saved permission intent loses its native receipt.
 * A rejected/unfinished retirement stays a barrier for this host lifetime. */
export class ApprovalRecovery {
  #retirements = new Map<string, Promise<void>>();
  async wait(sessionId: string): Promise<void> { await this.#retirements.get(sessionId); }
  async retire(sessionId: string, dispose: () => Promise<void>, forget: () => void): Promise<void> {
    let retirement = this.#retirements.get(sessionId);
    if (!retirement) {
      retirement = Promise.resolve().then(dispose);
      this.#retirements.set(sessionId, retirement);
    }
    try { await retirement; }
    catch { throw new Error("The permission choice was saved, but worker cleanup is unverified. This session is blocked until host recovery."); }
    forget();
    if (this.#retirements.get(sessionId) === retirement) this.#retirements.delete(sessionId);
  }
}
