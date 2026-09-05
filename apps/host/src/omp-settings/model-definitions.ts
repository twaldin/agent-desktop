import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ModelDefinitionPath, OmpModelDefinitions, OmpModelDefinitionsCatalog, OmpModelDefinitionsMutation, OmpModelDefinitionsSnapshot, SettingJson, SettingValueSchema } from "@agent-desktop/shared";
import { getModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema-bundle";
import { validateProviderConfiguration } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { stringifyYamlConfig } from "@oh-my-pi/pi-coding-agent/config/config-file";
import { replaceFileAtomically } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { OMP_RELEASE_COMMIT, OmpSettingsError } from "./schema";

const safeKey = (key: string) => !["__proto__", "constructor", "prototype"].includes(key);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const concealedNames = new Set(["apiKey", "headers", "baseUrl", "extraBody", "requestMetadata", "endpoint", "v2Endpoint", "streamingEndpoint"]);
const nativeSchema = getModelsConfigSchema();

/** Use the pinned validator's accepted input shape. Runtime narrow/normalization
 * callbacks still run on every final document; JSON Schema cannot encode them. */
export function modelDefinitionSchema(input: Record<string, unknown>, name?: string): SettingValueSchema {
  const supported = ["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "allOf", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "description"];
  if (Object.keys(input).some(key => !supported.includes(key))) throw new OmpSettingsError("unsupported", "Native model schema contains an unhandled descriptor keyword");
  let schema: SettingValueSchema;
  if (Array.isArray(input.enum) && input.enum.every(value => typeof value === "string")) schema = { kind: "enum", values: input.enum as string[] };
  else if (typeof input.const === "string") schema = { kind: "enum", values: [input.const] };
  else if (input.anyOf) schema = { kind: "union", alternatives: (input.anyOf as Record<string, unknown>[]).map(value => modelDefinitionSchema(value)) };
  else if (input.allOf) {
    const alternatives = (input.allOf as Record<string, unknown>[]).map(value => modelDefinitionSchema(value));
    if (!alternatives.every(value => value.kind === "object")) throw new OmpSettingsError("unsupported", "Native model intersection needs an explicit editor");
    schema = { kind: "object", fields: Object.assign({}, ...alternatives.map(value => value.fields)) };
  } else if (input.type === "array" && record(input.items)) schema = { kind: "array", item: modelDefinitionSchema(input.items) };
  else if (input.type === "object") {
    if (record(input.additionalProperties) && (!record(input.properties) || Object.keys(input.properties).length === 0)) schema = { kind: "map", value: modelDefinitionSchema(input.additionalProperties) };
    else {
      const required = new Set(input.required as string[] | undefined);
      if (input.additionalProperties && record(input.properties) && Object.keys(input.properties).length > 0) throw new OmpSettingsError("unsupported", "Native model mixed object/map schema needs an explicit editor");
      schema = { kind: "object", fields: Object.fromEntries(Object.entries(input.properties as Record<string, Record<string, unknown>> ?? {}).map(([key, value]) => [key, { schema: modelDefinitionSchema(value, key), optional: !required.has(key) }])) };
    }
  } else if (["string", "number", "boolean"].includes(input.type as string)) schema = { kind: input.type as "string" | "number" | "boolean" };
  else if (Object.keys(input).length === 0) schema = { kind: "json" };
  else throw new OmpSettingsError("unsupported", "Native model schema shape needs an explicit editor");
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) if (typeof input[key] === "number") schema[key] = input[key];
  if (typeof input.description === "string") schema.description = input.description;
  if (name && concealedNames.has(name)) schema.writeOnly = true;
  return schema;
}
let definitionSchemaCache: SettingValueSchema | undefined;
const definitionSchema = () => definitionSchemaCache ??= modelDefinitionSchema(nativeSchema.toJsonSchema({ io: "input" }));
export function modelDefinitionsCatalog(): OmpModelDefinitionsCatalog {
  return { version: "18.1.10", sourceCommit: OMP_RELEASE_COMMIT, schema: structuredClone(definitionSchema()), sourceFile: "packages/coding-agent/src/config/models-config-schema-bundle.ts",
    validator: "native-models-config-schema-and-provider-validation", rules: [
      "Provider definitions require an endpoint, credentials, discovery, models or a supported override; custom models require a base URL and an API at provider or model level.",
      "Custom model authentication requires apiKey unless native auth is none or oauth. Existing native account storage is not changed by this editor.",
      "Context/output limits must be positive when declared for custom models. Discovery timeouts must be positive; injectV1 is only valid for openai-models-list discovery.",
      "Thinking requires efforts, legacy levels, or a legacy minLevel/maxLevel range. OMP normalizes that input when loading models.",
      "Endpoints, API keys, headers, arbitrary request metadata and extra request bodies are write-only. Compound edits retain concealed values unless explicitly removed.",
      "Models with duplicate IDs must be edited by exact array index and revision. Ambiguous whole-array replacements and reordering are rejected to keep each row's concealed values attached correctly.",
      "Undeclared fields are preserved on disk but not returned as values or offered as guessed controls.",
    ] };
}
function assertJson(value: unknown, depth = 0): asserts value is SettingJson {
  if (depth > 32) throw new OmpSettingsError("invalid-value", "Model configuration is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) assertJson(item, depth + 1); return; }
  if (record(value)) { for (const [key, item] of Object.entries(value)) { if (!safeKey(key)) throw new OmpSettingsError("invalid-value", "Reserved model configuration key"); assertJson(item, depth + 1); } return; }
  throw new OmpSettingsError("invalid-value", "Model configuration must contain finite JSON-compatible values");
}
function validate(document: Record<string, SettingJson>): void {
  assertJson(document);
  try {
    const normalized = nativeSchema.assert(document);
    for (const [name, provider] of Object.entries(normalized.providers ?? {})) validateProviderConfiguration(name, { ...provider, models: provider.models ?? [] }, "models-config");
  } catch {
    // Native diagnostics can include submitted API keys/endpoints. Never relay
    // their message, validation object or cause across the host boundary.
    throw new OmpSettingsError("invalid-value", "The native model validator rejected this configuration. Check required API/endpoint/auth fields, model limits, thinking choices and discovery compatibility.");
  }
}
function descriptorAt(schema: SettingValueSchema, steps: ModelDefinitionPath): SettingValueSchema {
  let current = schema;
  for (const step of steps) {
    if (current.kind === "object" && typeof step === "string" && Object.hasOwn(current.fields, step)) current = current.fields[step].schema;
    else if (current.kind === "map" && typeof step === "string" && safeKey(step)) current = current.value;
    else if (current.kind === "array" && typeof step === "number" && Number.isInteger(step) && step >= 0) current = current.item;
    else throw new OmpSettingsError("invalid-setting", "This model definition path is not declared in the pinned native schema");
  }
  return current;
}
function assertDeclaredValue(value: SettingJson, schema: SettingValueSchema): void {
  if (schema.kind === "object" && record(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.fields, key)) throw new OmpSettingsError("invalid-setting", "A model edit contains a field absent from the pinned native schema");
      assertDeclaredValue(child as SettingJson, schema.fields[key].schema);
    }
  } else if (schema.kind === "map" && record(value)) {
    for (const child of Object.values(value)) assertDeclaredValue(child as SettingJson, schema.value);
  } else if (schema.kind === "array" && Array.isArray(value)) {
    for (const child of value) assertDeclaredValue(child, schema.item);
  }
}
function retainedOpaque(previous: unknown, schema: SettingValueSchema): SettingJson | undefined {
  if (previous === undefined) return undefined;
  if (schema.writeOnly) return structuredClone(previous) as SettingJson;
  if (schema.kind === "object" && record(previous)) {
    const entries = Object.entries(previous).flatMap(([key, value]) => {
      const kept = Object.hasOwn(schema.fields, key) ? retainedOpaque(value, schema.fields[key].schema) : structuredClone(value) as SettingJson;
      return kept === undefined ? [] : [[key, kept]];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  // Removing an entire model/map item is an explicit structural removal. The
  // UI issues a separate remove operation rather than dropping hidden values.
  return undefined;
}
function valueAt(document: unknown, steps: ModelDefinitionPath): unknown {
  let value = document;
  for (const key of steps) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
function modelArray(schema: SettingValueSchema): boolean {
  return schema.kind === "array" && schema.item.kind === "object" && Object.hasOwn(schema.item.fields, "id");
}
function duplicateModelIds(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const item of value) if (record(item) && typeof item.id === "string") {
    if (seen.has(item.id)) return true;
    seen.add(item.id);
  }
  return false;
}
const ambiguousModels = () => new OmpSettingsError("unsupported", "Duplicate native model IDs make this array replacement ambiguous. Edit each exact model row at the current revision; give rows distinct IDs before reordering.");
/** Preserve opaque values on an otherwise ordinary compound edit. Unique model
 * IDs allow reordering. Duplicate IDs only permit an unchanged nested array or
 * a direct row/field patch whose index was anchored to the read revision. */
function preserveConcealed(previous: unknown, next: SettingJson, schema: SettingValueSchema): SettingJson {
  if (schema.writeOnly) return next;
  if (schema.kind === "object" && record(previous) && record(next)) {
    const output = { ...next } as Record<string, SettingJson>;
    for (const [key, field] of Object.entries(schema.fields)) {
      if (field.schema.writeOnly && Object.hasOwn(previous, key) && !Object.hasOwn(output, key)) output[key] = structuredClone(previous[key]) as SettingJson;
      else if (Object.hasOwn(output, key)) output[key] = preserveConcealed(previous[key], output[key], field.schema);
      else {
        const retained = retainedOpaque(previous[key], field.schema);
        if (retained !== undefined) output[key] = retained;
      }
    }
    // Native schema permits unknown extension fields; editing known fields does
    // not erase them. Unknown values are not exposed to the renderer.
    for (const key of Object.keys(previous)) if (!Object.hasOwn(schema.fields, key) && !Object.hasOwn(output, key)) output[key] = structuredClone(previous[key]) as SettingJson;
    return output;
  }
  if (schema.kind === "array" && Array.isArray(previous) && Array.isArray(next)) {
    if (modelArray(schema) && (duplicateModelIds(previous) || duplicateModelIds(next))) {
      // Provider edits include their unedited public model array. Only this
      // exact public snapshot can safely retain duplicate rows by index. A
      // changed/reordered array cannot prove which concealed row it represents.
      const visible = valueAt(project({ providers: { native: { models: previous as SettingJson[] } } }).document, ["providers", "native", "models"]);
      if (!isDeepStrictEqual(next, visible)) throw ambiguousModels();
      return next.map((item, index) => preserveConcealed(previous[index], item, schema.item));
    }
    return next.map((item, index) => {
      const old = record(item) && typeof item.id === "string" ? previous.find(value => record(value) && value.id === item.id) : previous[index];
      return preserveConcealed(old, item, schema.item);
    });
  }
  if (schema.kind === "map" && record(previous) && record(next)) return Object.fromEntries(Object.entries(next).map(([key, value]) => [key, preserveConcealed(previous[key], value, schema.value)]));
  return structuredClone(next);
}
function applyChange(document: Record<string, SettingJson>, change: OmpModelDefinitionsMutation["changes"][number]): void {
  const steps = change.path;
  if (steps.length < 2 || steps.length > 32 || steps[0] !== "providers" || steps.some(step => typeof step === "string" ? !step || !safeKey(step) || step.includes("\0") || step.length > 1024 : !Number.isInteger(step) || step < 0 || step > 10_000)) throw new OmpSettingsError("invalid-setting", "Select a declared native provider/model field");
  const schema = descriptorAt(definitionSchema(), steps);
  let parent: Record<string | number, SettingJson> | SettingJson[] = document;
  for (let index = 0; index < steps.length - 1; index++) {
    const key = steps[index];
    if (Array.isArray(parent) && (typeof key !== "number" || key >= parent.length)) throw new OmpSettingsError("invalid-setting", "Native model array item no longer exists");
    const dictionary = parent as Record<string | number, SettingJson>;
    if (!Object.hasOwn(dictionary, key)) {
      if (change.operation === "remove") throw new OmpSettingsError("invalid-setting", "Native definition field no longer exists");
      dictionary[key] = typeof steps[index + 1] === "number" ? [] : {};
    }
    if (!dictionary[key] || typeof dictionary[key] !== "object") throw new OmpSettingsError("invalid-setting", "Native definition path is shadowed by another value");
    parent = dictionary[key] as Record<string | number, SettingJson>;
  }
  const key = steps.at(-1)!;
  if (Array.isArray(parent) && (typeof key !== "number" || key > parent.length || change.operation === "remove" && key === parent.length)) throw new OmpSettingsError("invalid-setting", "Native model array item no longer exists");
  if (change.operation === "remove") {
    if (!Object.hasOwn(parent, key)) throw new OmpSettingsError("invalid-setting", "Native definition field no longer exists");
    if (Array.isArray(parent)) parent.splice(key as number, 1); else delete parent[key];
  } else {
    assertJson(change.value);
    assertDeclaredValue(change.value, schema);
    if (modelArray(schema) && (duplicateModelIds((parent as Record<string | number, SettingJson>)[key]) || duplicateModelIds(change.value))) throw ambiguousModels();
    (parent as Record<string | number, SettingJson>)[key] = preserveConcealed((parent as Record<string | number, SettingJson>)[key], change.value, schema);
  }
}
function project(document: Record<string, SettingJson>): Pick<OmpModelDefinitionsSnapshot, "document" | "concealed" | "unsupportedPaths"> {
  const concealed: OmpModelDefinitionsSnapshot["concealed"] = [], unsupportedPaths: ModelDefinitionPath[] = [];
  function visit(value: SettingJson, schema: SettingValueSchema, current: ModelDefinitionPath): SettingJson | undefined {
    if (schema.writeOnly) { concealed.push({ path: current, configured: value !== null && value !== "" && (typeof value !== "object" || Object.keys(value).length > 0) }); return undefined; }
    if (schema.kind === "object" && record(value)) return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const field = schema.fields[key];
      if (!field) { unsupportedPaths.push([...current, key]); return []; }
      const projected = visit(item as SettingJson, field.schema, [...current, key]); return projected === undefined ? [] : [[key, projected]];
    }));
    if (schema.kind === "map" && record(value)) return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const projected = visit(item as SettingJson, schema.value, [...current, key]); return projected === undefined ? [] : [[key, projected]];
    }));
    if (schema.kind === "array" && Array.isArray(value)) return value.map((item, index) => visit(item, schema.item, [...current, index]) ?? null);
    return structuredClone(value);
  }
  return { document: visit(document, definitionSchema(), []) as Record<string, SettingJson>, concealed, unsupportedPaths };
}
/** Share the native config's structured compat projection with readonly model
 * metadata, so routing and whenThinking are visible without extraBody secrets. */
export function publicModelCompatibility(value: unknown): Record<string, SettingJson> {
  if (!record(value)) return {};
  const result = project({ providers: { native: { compat: value as Record<string, SettingJson> } } });
  return (valueAt(result.document, ["providers", "native", "compat"]) ?? {}) as Record<string, SettingJson>;
}
async function textIfPresent(file: string): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > 4 * 1024 * 1024) throw new OmpSettingsError("read-failed", "Native model definitions exceed the 4 MiB editor limit");
    return await readFile(file, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export class OmpModelDefinitionsStore {
  #fingerprint?: string;
  #revision = crypto.randomUUID();
  #tail: Promise<unknown> = Promise.resolve();
  #disposed = false;
  constructor(readonly agentDir: string) {}
  async #read(): Promise<{ raw: Record<string, SettingJson>; snapshot: OmpModelDefinitionsSnapshot }> {
    if (this.#disposed) throw new OmpSettingsError("unsupported", "Native model definition service is disposed");
    try {
      const yml = path.join(this.agentDir, "models.yml"), yaml = path.join(this.agentDir, "models.yaml"), json = path.join(this.agentDir, "models.json");
      const texts = await Promise.all([textIfPresent(yml), textIfPresent(yaml), textIfPresent(json)]);
      const index = texts.findIndex(value => value !== undefined);
      const sourcePath = [yml, yaml, json][index] ?? yml, source = texts[index];
      const format = (["yml", "yaml", "legacy-json"] as const)[index] ?? "missing";
      const parsed = source?.trim() ? format === "legacy-json" ? Bun.JSONC.parse(source) : Bun.YAML.parse(source) : {};
      if (!record(parsed)) throw new Error("Expected a mapping");
      validate(parsed as Record<string, SettingJson>);
      const raw = parsed as Record<string, SettingJson>;
      // Include all precedence candidates so concurrent legacy migration changes
      // invalidate a revision without exposing secret-dependent hashes.
      const fingerprint = createHash("sha256").update(JSON.stringify(texts)).digest("hex");
      if (fingerprint !== this.#fingerprint) { this.#fingerprint = fingerprint; this.#revision = crypto.randomUUID(); }
      return { raw, snapshot: { revision: this.#revision, sourcePath, writePath: format === "yaml" ? yaml : yml, format, ...project(raw), application: "discovery-refresh-and-new-sessions" } };
    } catch (error) {
      if (error instanceof OmpSettingsError) throw error;
      throw new OmpSettingsError("read-failed", "Native model definitions could not be read; no file or credential contents are included in this error");
    }
  }
  async read(): Promise<OmpModelDefinitions> { return { catalog: modelDefinitionsCatalog(), snapshot: (await this.#read()).snapshot }; }
  mutate(mutation: OmpModelDefinitionsMutation): Promise<OmpModelDefinitionsSnapshot> {
    const pending = this.#tail.then(() => this.#mutate(mutation)); this.#tail = pending.catch(() => {}); return pending;
  }
  async #mutate(mutation: OmpModelDefinitionsMutation): Promise<OmpModelDefinitionsSnapshot> {
    if (!mutation.changes.length || mutation.changes.length > 100) throw new OmpSettingsError("invalid-value", "A model edit must contain 1–100 changes");
    const before = await this.#read();
    if (before.snapshot.revision !== mutation.expectedRevision) throw new OmpSettingsError("conflict", "Native model definitions changed; reload before applying this edit");
    const file = before.snapshot.writePath;
    await mkdir(path.dirname(file), { recursive: true });
    let target: string;
    try { target = await realpath(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new OmpSettingsError("write-failed", "Cannot resolve the native model definition file");
      const metadata = await lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (metadata?.isSymbolicLink()) throw new OmpSettingsError("unsupported", "Repair the dangling native model configuration symlink before editing");
      target = path.join(await realpath(path.dirname(file)), path.basename(file));
    }
    try {
      await withFileLock(target, async () => {
        const current = await this.#read();
        if (current.snapshot.revision !== mutation.expectedRevision) throw new OmpSettingsError("conflict", "Native model definitions changed before the file lock was acquired");
        // A symlink/precedence change while waiting must not write another file.
        const nowTarget = await realpath(current.snapshot.writePath).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return current.snapshot.writePath; throw error; });
        if (nowTarget !== target) throw new OmpSettingsError("conflict", "The native model configuration target changed before writing");
        const next = structuredClone(current.raw);
        for (const change of mutation.changes) applyChange(next, change);
        validate(next);
        const serialized = stringifyYamlConfig(next);
        if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new OmpSettingsError("invalid-value", "Native model definitions exceed the 4 MiB editor limit");
        const metadata = await stat(target).catch(async error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return current.snapshot.format === "legacy-json" ? stat(current.snapshot.sourcePath) : undefined;
        });
        const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
          const handle = await open(temp, "wx", metadata ? metadata.mode & 0o7777 : 0o600);
          try {
            if (metadata) { await handle.chown(metadata.uid, metadata.gid); await handle.chmod(metadata.mode & 0o7777); }
            await handle.writeFile(serialized, "utf8"); await handle.sync();
          } finally { await handle.close(); }
          if ((await this.#read()).snapshot.revision !== mutation.expectedRevision) throw new OmpSettingsError("conflict", "Native model definitions changed while the replacement was staged");
          await replaceFileAtomically(temp, target);
          const directory = await open(path.dirname(target), "r");
          try { await directory.sync(); } finally { await directory.close(); }
        } finally { await rm(temp, { force: true }); }
      });
      return (await this.#read()).snapshot;
    } catch (error) {
      if (error instanceof OmpSettingsError) throw error;
      throw new OmpSettingsError("write-failed", "Native model write failed. Reload to inspect saved state; the submitted values are never echoed. File metadata must be preserved before replacement.");
    }
  }
  async dispose(): Promise<void> { await this.#tail; this.#disposed = true; }
}
