import {
  PULL_REQUESTS_HOST_HEADER,
  parsePullRequestReadRequest,
} from "../../../packages/shared/src/pull-requests";
import { PullRequestReadError, type PullRequests } from "./pull-requests";

const BODY_LIMIT = 256 * 1024;

async function body(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > BODY_LIMIT)
    throw new PullRequestReadError(
      "REQUEST_TOO_LARGE",
      "Pull request request exceeds 256 KiB.",
    );
  if (!request.body)
    throw new PullRequestReadError(
      "INVALID_REQUEST",
      "A pull request request body is required.",
    );
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel();
        throw new PullRequestReadError(
          "REQUEST_TOO_LARGE",
          "Pull request request exceeds 256 KiB.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PullRequestReadError(
      "INVALID_REQUEST",
      "Invalid pull request JSON body.",
    );
  }
}

export class PullRequestsHttp {
  constructor(
    private readonly hostId: string,
    private readonly pullRequests: PullRequests,
  ) {}
  private headers() {
    return {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      [PULL_REQUESTS_HOST_HEADER]: this.hostId,
    };
  }
  async route(
    request: Request,
    url = new URL(request.url),
  ): Promise<Response | undefined> {
    const write = url.pathname === "/v1/pull-requests/submit", status = url.pathname === "/v1/pull-requests/submission-status";
    if (url.pathname !== "/v1/pull-requests" && !write && !status) return undefined;
    if (request.headers.get(PULL_REQUESTS_HOST_HEADER) !== this.hostId)
      return Response.json(
        {
          code: "OWNER_CHANGED",
          error: "Select this host again before reading pull requests.",
        },
        { status: 409, headers: this.headers() },
      );
    try {
      if (write || status) {
        if (request.method !== "POST") throw new PullRequestReadError("METHOD_NOT_ALLOWED", "Use POST for pull request submissions.");
        const input = await body(request);
        return Response.json(write ? await this.pullRequests.submit(input, request.signal) : this.pullRequests.status(input), { headers: this.headers() });
      }
      const input =
        request.method === "GET"
          ? parsePullRequestReadRequest({
              type: "accounts",
              refresh: url.searchParams.get("refresh") === "true",
            })
          : request.method === "POST"
            ? parsePullRequestReadRequest(await body(request))
            : (() => {
                throw new PullRequestReadError(
                  "METHOD_NOT_ALLOWED",
                  "Use GET or POST for pull requests.",
                );
              })();
      return Response.json(
        await this.pullRequests.read(input, request.signal),
        { headers: this.headers() },
      );
    } catch (error) {
      if (request.signal.aborted)
        return Response.json(
          { code: "CANCELLED", error: "Pull request read was cancelled." },
          { status: 499, headers: this.headers() },
        );
      const safe = error instanceof PullRequestReadError;
      const code = safe ? error.code : "INVALID_REQUEST",
        message = safe ? error.message : "Invalid pull request request.";
      const status =
        code === "GH_MISSING" || code === "OFFLINE"
          ? 503
          : code === "RATE_LIMITED"
            ? 429
            : code === "AUTH_REQUIRED"
              ? 401
              : code === "HEAD_CHANGED" ||
                  code === "ACCOUNT_CHANGED" ||
                  code === "GH_CHANGED"
                ? 409
                : code === "METHOD_NOT_ALLOWED"
                  ? 405
                  : code === "TIMED_OUT"
                    ? 504
                    : code === "TOO_LARGE" || code === "REQUEST_TOO_LARGE"
                      ? 413
                      : 400;
      return Response.json(
        { code, error: message },
        { status, headers: this.headers() },
      );
    }
  }
}
