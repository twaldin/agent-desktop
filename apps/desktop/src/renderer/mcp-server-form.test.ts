import { expect, test } from "bun:test";
import { validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { expandEnvVarsDeep } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { buildMcpServerConfig, type McpServerFormInput } from "./mcp-server-form";

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
