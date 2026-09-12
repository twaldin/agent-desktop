import { describe, expect, test } from "bun:test";
import { PULL_REQUESTS_HOST_HEADER } from "../../../packages/shared/src/pull-requests";
import { PullRequestsHttp } from "./pull-requests-http";
import { PullRequestReadError, type PullRequests } from "./pull-requests";

const request = (method: string, body?: BodyInit, host = "host-1") =>
  new Request("http://host/v1/pull-requests", {
    method,
    body,
    headers: {
      [PULL_REQUESTS_HOST_HEADER]: host,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
  });

describe("pull request HTTP owner and body boundary", () => {
  test("GET returns account availability with private no-store headers", async () => {
    const reads: unknown[] = [];
    const service = {
      read: async (input: unknown) => {
        reads.push(input);
        return {
          type: "accounts",
          availability: {
            status: "unauthenticated",
            accounts: [],
            activeAccountId: null,
            message: "Sign in.",
          },
        };
      },
    } as unknown as PullRequests;
    const response = await new PullRequestsHttp("host-1", service).route(
      request("GET"),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get(PULL_REQUESTS_HOST_HEADER)).toBe("host-1");
    expect(reads).toEqual([{ type: "accounts", refresh: false }]);
  });

  test("rejects a foreign owner before parsing or dispatching its request body", async () => {
    let reads = 0;
    const service = {
      read: async () => {
        reads++;
        throw new Error();
      },
    } as unknown as PullRequests;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const response = await new PullRequestsHttp("host-1", service).route(
      request("POST", body, "host-2"),
    );
    expect(response?.status).toBe(409);
    expect(reads).toBe(0);
  });

  test("accepts a bounded exact POST and rejects malformed or oversized streamed input", async () => {
    const calls: unknown[] = [];
    const service = {
      read: async (input: unknown) => {
        calls.push(input);
        return {
          type: "accounts",
          availability: {
            status: "unauthenticated",
            accounts: [],
            activeAccountId: null,
            message: null,
          },
        };
      },
    } as unknown as PullRequests;
    const http = new PullRequestsHttp("host-1", service);
    expect(
      (
        await http.route(
          request("POST", JSON.stringify({ type: "accounts", refresh: true })),
        )
      )?.status,
    ).toBe(200);
    expect(calls).toEqual([{ type: "accounts", refresh: true }]);
    expect((await http.route(request("POST", "{")))?.status).toBe(400);
    const large = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200_000));
        controller.enqueue(new Uint8Array(100_000));
        controller.close();
      },
    });
    const response = await http.route(request("POST", large));
    expect(response?.status).toBe(413);
    expect(await response?.json()).toMatchObject({ code: "REQUEST_TOO_LARGE" });
  });

  test("maps safe availability failures without returning credential-bearing details", async () => {
    for (const [code, status] of [
      ["OFFLINE", 503],
      ["RATE_LIMITED", 429],
      ["AUTH_REQUIRED", 401],
    ] as const) {
      const service = {
        read: async () => {
          throw new PullRequestReadError(
            code,
            code === "OFFLINE"
              ? "GitHub is unreachable from this host."
              : code === "RATE_LIMITED"
                ? "GitHub rate limited this request. Try again later."
                : "The selected GitHub account needs authentication.",
          );
        },
      } as unknown as PullRequests;
      const response = await new PullRequestsHttp("host-1", service).route(
        request("GET"),
      );
      expect(response?.status).toBe(status);
      expect(response?.headers.get(PULL_REQUESTS_HOST_HEADER)).toBe("host-1");
      expect(JSON.stringify(await response?.json())).not.toContain("token");
    }
  });
});
