export interface McpServerFormInput {
  transport: "stdio" | "http" | "sse";
  command: string;
  url: string;
  args: string[];
  env: Array<{ key: string; value: string }>;
  envPassthrough: string[];
  headers: Array<{ key: string; value: string }>;
  headerEnv: Array<{ key: string; value: string }>;
  bearerTokenEnv: string;
  cwd: string;
  advanced: string;
}

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function advancedObject(source: string): Record<string, unknown> {
  if (!source.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Additional settings must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Additional settings must be a JSON object.");
  }
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (forbiddenKeys.has(key)) throw new Error(`Additional settings contain forbidden key "${key}".`);
      if (child && typeof child === "object") pending.push(child);
    }
  }
  return value as Record<string, unknown>;
}

function keyedRows(
  rows: Array<{ key: string; value: string }>,
  kind: "environment variable" | "HTTP header",
  result: Record<string, string> = Object.create(null) as Record<string, string>,
  seen: Set<string> = new Set(),
): Record<string, string> | undefined {
  for (const row of rows) {
    if (row.key === "" && row.value === "") continue;
    if (!row.key.trim()) throw new Error(`A ${kind} value requires a name.`);
    if (kind === "HTTP header" && !headerName.test(row.key)) {
      throw new Error(`HTTP header name "${row.key}" is invalid.`);
    }
    const identity = kind === "HTTP header" ? row.key.toLowerCase() : row.key;
    if (seen.has(identity)) throw new Error(`Duplicate ${kind} name "${row.key}".`);
    seen.add(identity);
    result[row.key] = row.value;
  }
  return seen.size ? result : undefined;
}

function placeholderName(value: string, label: string): string | undefined {
  const name = value.trim();
  if (!name) return undefined;
  if (/[:{}\0]/.test(name)) throw new Error(`${label} "${name}" cannot be expanded by the native environment placeholder syntax.`);
  return name;
}

function environment(input: McpServerFormInput): Record<string, string> | undefined {
  const result = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  keyedRows(input.env, "environment variable", result, seen);
  for (const source of input.envPassthrough) {
    const name = placeholderName(source, "Environment variable name");
    if (!name) continue;
    if (seen.has(name)) throw new Error(`Duplicate environment variable name "${name}".`);
    seen.add(name);
    result[name] = `\${${name}}`;
  }
  return seen.size ? result : undefined;
}

function httpHeaders(input: McpServerFormInput): Record<string, string> | undefined {
  const result = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  keyedRows(input.headers, "HTTP header", result, seen);
  for (const row of input.headerEnv) {
    if (row.key === "" && row.value === "") continue;
    if (!row.key.trim()) throw new Error("An HTTP header environment value requires a header name.");
    if (!headerName.test(row.key)) throw new Error(`HTTP header name "${row.key}" is invalid.`);
    const source = placeholderName(row.value, "Header environment variable name");
    if (!source) throw new Error(`HTTP header "${row.key}" requires an environment variable name.`);
    const identity = row.key.toLowerCase();
    if (seen.has(identity)) throw new Error(`Duplicate HTTP header name "${row.key}".`);
    seen.add(identity);
    result[row.key] = `\${${source}}`;
  }
  const bearer = placeholderName(input.bearerTokenEnv, "Bearer token environment variable name");
  if (bearer) {
    const identity = "authorization";
    if (seen.has(identity)) throw new Error('Duplicate HTTP header name "Authorization".');
    seen.add(identity);
    result.Authorization = `Bearer \${${bearer}}`;
  }
  return seen.size ? result : undefined;
}

export function buildMcpServerConfig(input: McpServerFormInput): Record<string, unknown> {
  const config = { ...advancedObject(input.advanced) };
  if (input.transport === "stdio") {
    delete config.url;
    delete config.headers;
    delete config.headerPolicy;
    const command = input.command.trim();
    if (!command) throw new Error("Command is required for a stdio server.");
    const env = environment(input);
    config.type = "stdio";
    config.command = command;
    config.args = [...input.args];
    if (env) config.env = env;
    else delete config.env;
    if (input.cwd.trim()) config.cwd = input.cwd;
    else delete config.cwd;
    return config;
  }

  delete config.command;
  delete config.args;
  delete config.env;
  delete config.envPolicy;
  delete config.envLiteralKeys;
  delete config.cwd;
  const url = input.url.trim();
  if (!url) throw new Error("URL is required for an HTTP or SSE server.");
  const headers = httpHeaders(input);
  config.type = input.transport;
  config.url = url;
  if (headers) config.headers = headers;
  else delete config.headers;
  return config;
}
