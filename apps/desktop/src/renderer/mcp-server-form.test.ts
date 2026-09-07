import { expect, test } from "bun:test";
import { validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { expandEnvVarsDeep } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { buildMcpServerConfig, readMcpServerForm, updateMcpServerConfig, type McpServerFormInput } from "./mcp-server-form";

const base = (overrides: Partial<McpServerFormInput> = {}): McpServerFormInput => ({
  transport: "stdio",
  command: " bun ",
  url: "",
  args: [],
  env: [],
  envPassthrough: [],
  headers: [],
  headerEnv: [],
  bearerTokenEnv: "",
  cwd: "",
  advanced: "",
  ...overrides,
});

test("stdio typed fields override advanced transport fields while preserving exact rows and native extras", () => {
  const config = buildMcpServerConfig(base({
    args: ["", " ", "--flag", "two words"],
    env: [{ key: "TOKEN", value: "" }, { key: "Mixed", value: "  exact value  " }, { key: "", value: "" }],
    cwd: " /path with surrounding spaces ",
    advanced: JSON.stringify({ type: "http", url: "https://inactive.invalid", headers: { stale: "yes" }, timeout: 123, requestIdFormat: "string", envPolicy: "literal", command: "ignored" }),
  }));
  expect(config).toEqual({
    type: "stdio",
    command: "bun",
    args: ["", " ", "--flag", "two words"],
    env: { TOKEN: "", Mixed: "  exact value  " },
    cwd: " /path with surrounding spaces ",
    timeout: 123,
    requestIdFormat: "string",
    envPolicy: "literal",
  });
  expect(validateServerConfig("fixture", config as unknown as MCPServerConfig)).toEqual([]);
});

test.each(["http", "sse"] as const)("%s fields remove inherited stdio settings and preserve header values", transport => {
  const config = buildMcpServerConfig(base({
    transport,
    command: "inactive",
    url: "  https://example.test/mcp  ",
    headers: [{ key: "Authorization", value: "" }, { key: "X-Fixture", value: "  exact  " }],
    advanced: JSON.stringify({ command: "old", args: ["old"], env: { OLD: "yes" }, envPolicy: "literal", envLiteralKeys: ["OLD"], cwd: "/old", timeout: 0, headerPolicy: "origin-locked", url: "ignored" }),
  }));
  expect(config).toEqual({
    type: transport,
    url: "https://example.test/mcp",
    headers: { Authorization: "", "X-Fixture": "  exact  " },
    timeout: 0,
    headerPolicy: "origin-locked",
  });
  expect(validateServerConfig("fixture", config as unknown as MCPServerConfig)).toEqual([]);
});

test("blank optional rows are omitted while named empty values remain", () => {
  expect(buildMcpServerConfig(base({ env: [{ key: "", value: "" }] }))).toEqual({ type: "stdio", command: "bun", args: [] });
  expect(buildMcpServerConfig(base({ transport: "http", url: "https://example.test", headers: [{ key: "Empty", value: "" }] }))).toEqual({
    type: "http", url: "https://example.test", headers: { Empty: "" },
  });
});

test("native placeholder fields merge without reading ambient environment and expand with explicit values", () => {
  const stdio = buildMcpServerConfig(base({
    env: [{ key: "LITERAL", value: "literal value" }],
    envPassthrough: ["  API_KEY  ", "EMPTY"],
  }));
  expect(stdio).toMatchObject({ env: { LITERAL: "literal value", API_KEY: "${API_KEY}", EMPTY: "${EMPTY}" } });
  expect(expandEnvVarsDeep(stdio, { API_KEY: "fixture-secret", EMPTY: "" })).toMatchObject({
    env: { LITERAL: "literal value", API_KEY: "fixture-secret", EMPTY: "" },
  });

  const http = buildMcpServerConfig(base({
    transport: "http",
    url: "https://example.test",
    headers: [{ key: "X-Literal", value: " literal " }],
    headerEnv: [{ key: "X-From-Env", value: "  HEADER_VALUE " }],
    bearerTokenEnv: " TOKEN_VALUE ",
  }));
  expect(http).toMatchObject({ headers: {
    "X-Literal": " literal ",
    "X-From-Env": "${HEADER_VALUE}",
    Authorization: "Bearer ${TOKEN_VALUE}",
  } });
  expect(expandEnvVarsDeep(http, { HEADER_VALUE: "fixture-header", TOKEN_VALUE: "fixture-token" })).toMatchObject({ headers: {
    "X-Literal": " literal ",
    "X-From-Env": "fixture-header",
    Authorization: "Bearer fixture-token",
  } });
});

test("ambiguous and invalid keyed rows are rejected instead of silently overwriting", () => {
  expect(() => buildMcpServerConfig(base({ env: [{ key: "A", value: "1" }, { key: "A", value: "2" }] }))).toThrow("Duplicate environment variable");
  expect(() => buildMcpServerConfig(base({ env: [{ key: " ", value: "present" }] }))).toThrow("requires a name");
  expect(() => buildMcpServerConfig(base({ transport: "http", url: "https://example.test", headers: [{ key: "Accept", value: "a" }, { key: "accept", value: "b" }] }))).toThrow("Duplicate HTTP header");
  expect(() => buildMcpServerConfig(base({ transport: "http", url: "https://example.test", headers: [{ key: "Bad Header", value: "x" }] }))).toThrow("is invalid");
  expect(() => buildMcpServerConfig(base({ env: [{ key: "API_KEY", value: "literal" }], envPassthrough: [" API_KEY "] }))).toThrow("Duplicate environment variable");
  expect(() => buildMcpServerConfig(base({ envPassthrough: ["BAD:NAME"] }))).toThrow("cannot be expanded");
  expect(() => buildMcpServerConfig(base({ transport: "http", url: "https://example.test", headers: [{ key: "authorization", value: "literal" }], bearerTokenEnv: "TOKEN" }))).toThrow("Duplicate HTTP header");
  expect(() => buildMcpServerConfig(base({ transport: "http", url: "https://example.test", headerEnv: [{ key: "X-Key", value: "BAD}NAME" }] }))).toThrow("cannot be expanded");
});

test("advanced input must be a safe JSON object and cannot override required typed values", () => {
  expect(() => buildMcpServerConfig(base({ advanced: "{" }))).toThrow("valid JSON");
  expect(() => buildMcpServerConfig(base({ advanced: "[]" }))).toThrow("JSON object");
  expect(() => buildMcpServerConfig(base({ advanced: '{"oauth":{"constructor":{"secret":"x"}}}' }))).toThrow("forbidden key");
  expect(() => buildMcpServerConfig(base({ advanced: '{"__proto__":{"polluted":true}}' }))).toThrow("forbidden key");
  expect(buildMcpServerConfig(base({ advanced: '{"command":"hidden","args":["hidden"]}' }))).toMatchObject({ command: "bun", args: [] });
});

test("required active fields use the visible trimmed value", () => {
  expect(() => buildMcpServerConfig(base({ command: "   " }))).toThrow("Command is required");
  expect(() => buildMcpServerConfig(base({ transport: "sse", url: " \n " }))).toThrow("URL is required");
});

test("reads native stdio fields without trimming literals and preserves opaque settings", () => {
  const input = readMcpServerForm({
    type: "stdio", command: "  node  ", args: ["", "two words"], cwd: " /tmp/work ",
    env: { TOKEN: " literal ", API_KEY: "${API_KEY}" },
    startup_timeout_ms: 1234, auth: { type: "oauth", resource: "https://example.test" }, env_vars: ["NATIVE_ONLY"],
  });
  expect(input).toMatchObject({ transport: "stdio", command: "  node  ", args: ["", "two words"], cwd: " /tmp/work ",
    env: [{ key: "TOKEN", value: " literal " }], envPassthrough: ["API_KEY"] });
  expect(JSON.parse(input.advanced)).toEqual({ startup_timeout_ms: 1234, auth: { type: "oauth", resource: "https://example.test" }, env_vars: ["NATIVE_ONLY"] });
  expect(buildMcpServerConfig(input, { preserveCommandWhitespace: true })).toMatchObject({ type: "stdio", command: "  node  ", args: ["", "two words"], env: { TOKEN: " literal ", API_KEY: "${API_KEY}" } });
});

test("keeps non-exact placeholders and whitespace names literal during edit", () => {
  const input = readMcpServerForm({ type: "stdio", command: " /bin/tool ", env: {
    " TOKEN ": "${ TOKEN }", FALLBACK: "${TOKEN:-fallback}", EXACT: "${EXACT}",
  }, auth: { type: "oauth" }, oauth: { clientId: "opaque" }, envPolicy: "literal" });
  expect(input.envPassthrough).toEqual(["EXACT"]);
  expect(input.env).toEqual([{ key: " TOKEN ", value: "${ TOKEN }" }, { key: "FALLBACK", value: "${TOKEN:-fallback}" }]);
  expect(JSON.parse(input.advanced)).toEqual({ auth: { type: "oauth" }, oauth: { clientId: "opaque" }, envPolicy: "literal" });
  expect(buildMcpServerConfig(input, { preserveCommandWhitespace: true })).toMatchObject({ command: " /bin/tool ", env: {
    " TOKEN ": "${ TOKEN }", FALLBACK: "${TOKEN:-fallback}", EXACT: "${EXACT}",
  } });
});

test("reads HTTP placeholders only when their syntax is exact", () => {
  const input = readMcpServerForm({ type: "http", url: " https://example.test/mcp ", headers: {
    Authorization: "Bearer ${TOKEN}", "X-From-Env": "${HEADER}", "X-Literal": " ${NOT_A_PLACEHOLDER} ",
  }, timeout: 0 });
  expect(input).toMatchObject({ transport: "http", url: " https://example.test/mcp ", bearerTokenEnv: "TOKEN",
    headerEnv: [{ key: "X-From-Env", value: "HEADER" }], headers: [{ key: "X-Literal", value: " ${NOT_A_PLACEHOLDER} " }] });
  expect(JSON.parse(input.advanced)).toEqual({ timeout: 0 });
});

test("rejects unsupported or ambiguous native shapes", () => {
  expect(() => readMcpServerForm({ type: "websocket", url: "https://example.test" })).toThrow("Unsupported MCP transport");
  expect(() => readMcpServerForm({ command: "node", url: "https://example.test" })).toThrow("supported transport");
  expect(() => readMcpServerForm({ type: "stdio", command: "node", args: ["ok", 1] })).toThrow("array of strings");
  expect(JSON.parse(readMcpServerForm({ type: "http", url: "https://example.test", env_http_headers: { X: "literal" } }).advanced)).toEqual({ env_http_headers: { X: "literal" } });
});

test("updates only changed stdio groups and preserves original native keys", () => {
  const original = { command: " /bin/tool ", args: ["one", "two"], env: { TOKEN: "literal" },
    Authorization: "Bearer ${OLD}", envLiteralKeys: ["TOKEN"], auth: { type: "oauth" }, type: "stdio" };
  const input = readMcpServerForm(original);
  input.args = ["one"];
  const updated = updateMcpServerConfig(original, input);
  expect(updated).toEqual({ ...original, args: ["one"] });
  expect(updated).not.toHaveProperty("url");
});

test("changed URL does not rewrite opaque headers or add absent type", () => {
  const original = { url: "https://old.example/mcp", headers: { authorization: "Bearer ${TOKEN:-fallback}" },
    oauth: { resource: "https://resource.example" }, policy: "native" };
  const input = readMcpServerForm(original);
  input.url = "https://new.example/mcp";
  const updated = updateMcpServerConfig(original, input);
  expect(updated).toEqual({ ...original, url: "https://new.example/mcp" });
});

test("explicit row removal deletes the active native key and advanced edits apply", () => {
  const original = { type: "stdio", command: "node", args: ["--keep"], env: { A: "1" },
    auth: { type: "oauth" }, timeout: 10 };
  const input = readMcpServerForm(original);
  input.args = [];
  input.advanced = JSON.stringify({ auth: { type: "oauth" }, timeout: 20, newPolicy: true });
  const updated = updateMcpServerConfig(original, input);
  expect(updated).toEqual({ type: "stdio", command: "node", env: { A: "1" }, auth: { type: "oauth" }, timeout: 20, newPolicy: true });
});

test("advanced modeled keys cannot override the displayed command or transport", () => {
  const original = { type: "stdio", command: "node", timeout: 1 };
  const input = readMcpServerForm(original);
  input.advanced = JSON.stringify({ command: "evil", type: "sse", timeout: 5 });
  expect(updateMcpServerConfig(original, input)).toEqual({ type: "stdio", command: "node", timeout: 5 });
});

test("blank editable env and header placeholders do not count as changes", () => {
  const original = { type: "stdio", command: "node", env: {}, headers: {} };
  const input = readMcpServerForm(original);
  input.env = [{ key: "", value: "" }];
  input.headers = [{ key: "", value: "" }];
  input.envPassthrough = [""];
  input.headerEnv = [{ key: "", value: "" }];
  expect(updateMcpServerConfig(original, input)).toEqual(original);
});
