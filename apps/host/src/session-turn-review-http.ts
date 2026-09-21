import { parseTurnReview, TURN_REVIEW_OWNER_HEADER, type TurnReview } from "../../../packages/shared/src/turn-review";
interface TurnReviewOwner { getTurnReview(): Promise<TurnReview> }
/** Uses the already-owned native session. Reading never starts a provider, tool, or filesystem capture. */
export class SessionTurnReviewHttp {
  #reads = new Map<TurnReviewOwner, Promise<TurnReview>>();
  constructor(private readonly options: {
    hostId: string;
    sessionExists(id: string): boolean;
    existing(id: string): Promise<TurnReviewOwner | undefined>;
  }) {}
  async route(request: Request, url = new URL(request.url)): Promise<Response | undefined> {
    const match = /^\/v1\/sessions\/([^/]+)\/turn-review$/.exec(url.pathname);
    if (!match) return;
    const headers = { "Cache-Control": "no-store", [TURN_REVIEW_OWNER_HEADER]: this.options.hostId };
    const fail = (status: number, error: string) => Response.json({ error }, { status, headers });
    if (request.method !== "GET") return fail(405, "Use GET for recorded turn review.");
    if (request.headers.get(TURN_REVIEW_OWNER_HEADER) !== this.options.hostId) return fail(409, "The selected recorded review host changed.");
    let id: string;
    try { id = decodeURIComponent(match[1]!); } catch { return fail(400, "Invalid conversation identity."); }
    if (!id || id.length > 200 || /[\0-\x1f\x7f]/.test(id)) return fail(400, "Invalid conversation identity.");
    try {
      if (!this.options.sessionExists(id)) return fail(409, "The original conversation is unavailable.");
      const owner = await this.options.existing(id);
      if (!owner) return fail(503, "Open the original conversation to read its saved turn evidence.");
      let pending = this.#reads.get(owner);
      if (!pending) {
        pending = owner.getTurnReview(); this.#reads.set(owner, pending);
        const release = () => { if (this.#reads.get(owner) === pending) this.#reads.delete(owner); };
        void pending.then(release, release);
      }
      const value = parseTurnReview(await pending);
      if (value.sessionId !== id || !this.options.sessionExists(id) || await this.options.existing(id) !== owner) return fail(409, "The original recorded review owner retired.");
      return Response.json({ hostId: this.options.hostId, sessionId: id, value }, { headers });
    } catch (error) { return fail(503, `Recorded review could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
