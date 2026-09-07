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

const modeledMcpKeys = new Set([
  "type", "command", "args", "env", "cwd", "url", "headers",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${label} must be an array of strings.`);
  return value as string[];
}

function rows(value: unknown, label: string): Array<{ key: string; value: string }> {
  const source = record(value, label);
  return Object.entries(source).map(([key, item]) => {
    if (typeof item !== "string") throw new Error(`${label} values must be strings.`);
    return { key, value: item };
  });
}

function advancedFields(config: Record<string, unknown>): string {
  const value: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(config)) if (!modeledMcpKeys.has(key)) value[key] = item;
  return Object.keys(value).length ? JSON.stringify(value) : "";
}

const nativePlaceholderName = /^[^:{}\0\s]+$/;
const exactPlaceholder = (value: string): string | undefined => {
  const match = /^\$\{([^{}]+)\}$/.exec(value);
  return match && nativePlaceholderName.test(match[1]!) ? match[1] : undefined;
};

/** Converts the native OMP config shape into the editable form model without
 * resolving placeholders or trimming literal values. */
export function readMcpServerForm(config: Record<string, unknown>): McpServerFormInput {
  const source = record(config, "MCP configuration");
  const declared = source.type;
  let transport: McpServerFormInput["transport"];
  if (declared !== undefined) {
    if (declared !== "stdio" && declared !== "http" && declared !== "sse") throw new Error("Unsupported MCP transport.");
    transport = declared;
  } else if (typeof source.command === "string" && source.url === undefined) transport = "stdio";
  else if (typeof source.url === "string" && source.command === undefined) transport = "http";
  else throw new Error("MCP configuration must declare a supported transport.");

  const args = source.args === undefined ? [] : strings(source.args, "MCP arguments");
  const envSource = source.env === undefined ? {} : record(source.env, "MCP environment");
  const env: Array<{ key: string; value: string }> = [];
  const envPassthrough: string[] = [];
  for (const [key, item] of Object.entries(envSource)) {
    if (typeof item !== "string") throw new Error("MCP environment values must be strings.");
    const exact = exactPlaceholder(item);
    if (key === key.trim() && nativePlaceholderName.test(key) && exact === key) envPassthrough.push(key);
    else env.push({ key, value: item });
  }
  const headersSource = source.headers === undefined ? {} : record(source.headers, "MCP headers");
  const headers: Array<{ key: string; value: string }> = [];
  const headerEnv: Array<{ key: string; value: string }> = [];
  let bearerTokenEnv = "";
  for (const [key, item] of Object.entries(headersSource)) {
    if (typeof item !== "string") throw new Error("MCP header values must be strings.");
    const bearer = /^Bearer \$\{([^{}]+)\}$/.exec(item);
    const bearerName = bearer ? exactPlaceholder(`\${${bearer[1]!}}`) : undefined;
    if (key.toLowerCase() === "authorization" && bearerName) { bearerTokenEnv = bearerName; continue; }
    const exact = exactPlaceholder(item);
    if (exact) headerEnv.push({ key, value: exact });
    else headers.push({ key, value: item });
  }
  keyedRows(headers, "HTTP header");
  const headerNames = new Set<string>();
  for (const row of headerEnv) {
    const identity = row.key.toLowerCase();
    if (headerNames.has(identity)) throw new Error(`Duplicate HTTP header name "${row.key}".`);
    headerNames.add(identity);
  }
  const command = source.command === undefined ? "" : typeof source.command === "string" ? source.command : (() => { throw new Error("MCP command must be a string."); })();
  const url = source.url === undefined ? "" : typeof source.url === "string" ? source.url : (() => { throw new Error("MCP URL must be a string."); })();
  const cwd = source.cwd === undefined ? "" : typeof source.cwd === "string" ? source.cwd : (() => { throw new Error("MCP working directory must be a string."); })();
  if (transport === "stdio" && !command) throw new Error("stdio MCP configuration requires a command.");
  if (transport !== "stdio" && !url) throw new Error("HTTP MCP configuration requires a URL.");
  return { transport, command, url, args: [...args], env, envPassthrough, headers, headerEnv, bearerTokenEnv, cwd, advanced: advancedFields(source) };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formGroup(input: McpServerFormInput, group: "args" | "env" | "headers"): unknown {
  if (group === "args") return input.args;
  if (group === "env") return { env: input.env.filter(row => row.key !== "" || row.value !== ""), envPassthrough: input.envPassthrough.filter(Boolean) };
  return { headers: input.headers.filter(row => row.key !== "" || row.value !== ""), headerEnv: input.headerEnv.filter(row => row.key !== "" || row.value !== ""), bearerTokenEnv: input.bearerTokenEnv };
}

function opaqueAdvanced(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !modeledMcpKeys.has(key)));
}

/** Applies an edited form to the original native object without rewriting
 * untouched or opaque native fields. Transport changes remain unsupported. */
export function updateMcpServerConfig(original: Record<string, unknown>, input: McpServerFormInput): Record<string, unknown> {
  const initial = readMcpServerForm(original);
  if (input.transport !== initial.transport) throw new Error("MCP transport cannot be changed while editing.");
  const built = buildMcpServerConfig(input, { preserveCommandWhitespace: true });
  const result = structuredClone(original) as Record<string, unknown>;
  const setOrDelete = (key: string, value: unknown) => { if (value === undefined) delete result[key]; else result[key] = value; };

  if (input.transport === "stdio" && input.command !== initial.command) setOrDelete("command", built.command);
  if (input.transport !== "stdio" && input.url !== initial.url) setOrDelete("url", built.url);
  if (!sameJson(formGroup(input, "args"), formGroup(initial, "args"))) setOrDelete("args", Array.isArray(built.args) && built.args.length ? built.args : undefined);
  if (!sameJson(formGroup(input, "env"), formGroup(initial, "env"))) setOrDelete("env", built.env);
  if (!sameJson(formGroup(input, "headers"), formGroup(initial, "headers"))) setOrDelete("headers", built.headers);
  if (input.cwd !== initial.cwd) setOrDelete("cwd", built.cwd);

  const oldAdvanced = initial.advanced.trim() ? opaqueAdvanced(JSON.parse(initial.advanced) as Record<string, unknown>) : {};
  const newAdvanced = input.advanced.trim() ? opaqueAdvanced(JSON.parse(input.advanced) as Record<string, unknown>) : {};
  if (!sameJson(oldAdvanced, newAdvanced)) {
    for (const key of Object.keys(oldAdvanced)) if (!Object.hasOwn(newAdvanced, key)) delete result[key];
    Object.assign(result, newAdvanced);
  }
  return result;
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

export function buildMcpServerConfig(input: McpServerFormInput, options: { preserveCommandWhitespace?: boolean } = {}): Record<string, unknown> {
  const config = { ...advancedObject(input.advanced) };
  if (input.transport === "stdio") {
    delete config.url;
    delete config.headers;
    delete config.headerPolicy;
    const command = options.preserveCommandWhitespace ? input.command : input.command.trim();
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
  const url = options.preserveCommandWhitespace ? input.url : input.url.trim();
  if (!url) throw new Error("URL is required for an HTTP or SSE server.");
  const headers = httpHeaders(input);
  config.type = input.transport;
  config.url = url;
  if (headers) config.headers = headers;
  else delete config.headers;
  return config;
}
