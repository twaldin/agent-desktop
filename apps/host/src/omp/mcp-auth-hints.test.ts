import { afterEach, describe, expect, test } from "bun:test";
import {
  formatMCPToolFailure,
  getMcpTransportAuthHints,
  MCPTransportError,
} from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";

let server: Bun.Server<unknown> | undefined;
afterEach(() => server?.stop(true));

describe("private MCP HTTP authentication hints", () => {
  test("retains challenge headers by error identity while diagnostics stay redacted", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("authorization required", {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer resource_metadata="http://127.0.0.1/protected?tenant=blue&token=fixture-private", scope="challenge:read"',
            "Mcp-Auth-Server": "http://127.0.0.1/issuer?tenant=blue&token=fixture-private",
          },
        });
      },
    });
    const transport = new HttpTransport({ type: "http", url: `http://127.0.0.1:${server.port}/mcp` });
    await transport.connect();

    let failure: unknown;
    try {
      await transport.request("tools/list");
    } catch (error) {
      failure = error;
    } finally {
      await transport.close();
    }

    expect(failure).toBeInstanceOf(MCPTransportError);
    expect(getMcpTransportAuthHints(failure)).toEqual({
      wwwAuthenticate:
        'Bearer resource_metadata="http://127.0.0.1/protected?tenant=blue&token=fixture-private", scope="challenge:read"',
      mcpAuthServer: "http://127.0.0.1/issuer?tenant=blue&token=fixture-private",
    });
    expect(getMcpTransportAuthHints(new Error("wrapper", { cause: failure }))).toEqual(
      getMcpTransportAuthHints(failure),
    );
    const diagnostic = `${String(failure)}\n${JSON.stringify(failure)}\n${formatMCPToolFailure(failure, "fixture", "tools/list")}`;
    expect(diagnostic).not.toContain("resource_metadata");
    expect(diagnostic).not.toContain("fixture-private");
    expect(diagnostic).toContain("Bearer [redacted]");
    expect(diagnostic).toContain("token=[redacted]");
  });
});
