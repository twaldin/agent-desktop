/** Static inventory comparison. Expressions are evidence strings, never evaluated. */
export type Status = "unchanged" | "changed" | "unknown" | "invalid";
export interface Evidence { path: string; sha256?: string; bytes?: number; url?: string; pointer?: string; line?: number; note?: string }
export interface InventoryRow { id: string; facets: Record<string, unknown>; source: Evidence }
export interface Delta { id: string; kind: "added" | "removed" | "changed"; facets: string[]; before?: Record<string, unknown>; after?: Record<string, unknown>; sources: Evidence[] }
export interface Check { id: string; title: string; status: Status; details: string[]; sources: Evidence[]; before?: unknown; after?: unknown; deltas?: Delta[]; counts?: { before: number; after: number; added: number; removed: number; changed: number } }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
}
export function list(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function index(rows: InventoryRow[]): Map<string, InventoryRow> {
  const result = new Map<string, InventoryRow>();
  for (const row of rows) {
    if (result.has(row.id)) throw new Error(`Duplicate inventory identity: ${row.id}`);
    result.set(row.id, row);
  }
  return result;
}
export function compareRows(id: string, title: string, before: InventoryRow[], after: InventoryRow[], sources: Evidence[], details: string[] = []): Check {
  const left = index(before), right = index(after), deltas: Delta[] = [];
  for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(key), b = right.get(key);
    if (a && b && canonical(a.facets) === canonical(b.facets)) continue;
    deltas.push({ id: key, kind: !a ? "added" : !b ? "removed" : "changed",
      facets: [...new Set([...Object.keys(a?.facets ?? {}), ...Object.keys(b?.facets ?? {})])].filter(facet => canonical(a?.facets[facet]) !== canonical(b?.facets[facet])).sort(),
      ...(a ? { before: a.facets } : {}), ...(b ? { after: b.facets } : {}), sources: [a?.source, b?.source].filter((source): source is Evidence => !!source) });
  }
  return { id, title, status: deltas.length ? "changed" : "unchanged", details, sources, deltas,
    counts: { before: left.size, after: right.size, added: deltas.filter(d => d.kind === "added").length, removed: deltas.filter(d => d.kind === "removed").length, changed: deltas.filter(d => d.kind === "changed").length } };
}
function sourceAt(file: Evidence, pointer: string, source?: any): Evidence {
  return { ...file, pointer, ...(typeof source === "string" ? { url: source } : source && typeof source === "object" ? {
    ...(typeof source.url === "string" ? { url: source.url } : {}), ...(Number.isInteger(source.line) ? { line: source.line } : {}),
  } : {}) };
}
export function settingRows(input: unknown, file: Evidence): InventoryRow[] {
  return list(object(input, file.path).settings, "settings").map((item, i) => {
    const value = object(item, `settings[${i}]`);
    const path = string(value.path, "setting path"), type = string(value.type, `setting ${path} type`);
    if (!Object.hasOwn(value, "defaultExpression")) throw new Error(`Setting ${path} is missing defaultExpression; runtime values are not a static inventory`);
    return { id: path, facets: { type, defaultExpression: value.defaultExpression, defaultLiteralOrExpression: value.defaultLiteralOrExpression, enumValuesExpression: value.enumValuesExpression,
      credential: value.credential, ui: value.ui, declarationExpression: value.descriptorExpression }, source: sourceAt(file, `/settings/${i}`, value.source) };
  });
}
export function capabilityRows(input: unknown, file: Evidence): InventoryRow[] {
  const value = object(input, file.path), interfaces = object(value.interfaces, "interfaces"), rows: InventoryRow[] = [];
  for (const [name, raw] of Object.entries(interfaces)) {
    const declaration = object(raw, `interface ${name}`), pointer = `/interfaces/${name}`;
    rows.push({ id: `interface:${name}`, facets: { declarationExpression: string(declaration.declarationExpression, `${name} declarationExpression`) }, source: sourceAt(file, pointer, declaration.source) });
    for (const [i, rawField] of list(declaration.fields, `${name} fields`).entries()) {
      const field = object(rawField, `${name} field`);
      rows.push({ id: `field:${name}.${string(field.field, "field name")}`, facets: { typeExpression: string(field.typeExpressionLine, "field typeExpressionLine"), optional: field.optional }, source: {
        ...sourceAt(file, `${pointer}/fields/${i}`, declaration.source), ...(Number.isInteger(field.sourceLine) ? { line: field.sourceLine,
          ...(typeof declaration.source === "string" ? { url: `${declaration.source.split("#")[0]}#L${field.sourceLine}` } : {}) } : {}),
      } });
    }
  }
  if (value.configurationSchemas !== undefined) for (const [name, raw] of Object.entries(object(value.configurationSchemas, "configurationSchemas"))) {
    const declaration = object(raw, `configuration schema ${name}`);
    for (const [field, expression] of Object.entries(object(declaration.properties, `${name} properties`))) {
      rows.push({ id: `configuration:${name}.${field.replace(/\?$/, "")}`, facets: { typeExpression: expression, optional: field.endsWith("?") }, source: sourceAt(file, `/configurationSchemas/${name}/properties/${field}`, declaration.source) });
    }
  }
  return rows;
}
export function visualRows(input: unknown, file: Evidence): InventoryRow[] {
  const value = object(input, file.path), rows = new Map<string, InventoryRow>();
  function push(id: string, facet: string, item: unknown, pointer: string) {
    let row = rows.get(id);
    if (!row) { row = { id, facets: { [facet]: [] }, source: sourceAt(file, pointer) }; rows.set(id, row); }
    (row.facets[facet] as unknown[]).push(item);
  }
  for (const [i, raw] of list(value.custom_property_declarations, "custom_property_declarations").entries()) {
    const d = object(raw, "custom property");
    push(`token:${string(d.name, "token name")}`, "declarations", { source_file: d.source_file, source_order: d.source_order, selector_path: d.selector_path,
      rule_path: list(d.rule_path, "rule_path").map(rule => ({ kind: rule.kind, prelude_raw: rule.prelude_raw })), value_raw: d.value_raw, important: d.important }, `/custom_property_declarations/${i}`);
  }
  for (const [i, raw] of list(value.font_face_declarations, "font_face_declarations").entries()) {
    const face = object(raw, "font face"), declarations = list(face.declarations, "font face declarations");
    const family = declarations.find(d => d.name === "font-family")?.value_raw;
    push(`font:${family ?? "<anonymous>"}`, "declarations", { source_file: face.source_file,
      rule_path: face.rule_path?.map((rule: any) => ({ kind: rule.kind, prelude_raw: rule.prelude_raw })),
      declarations: declarations.map(d => ({ name: d.name, value_raw: d.value_raw, important: d.important, source_file: d.source_file, source_order: d.source_order })) }, `/font_face_declarations/${i}`);
  }
  for (const key of ["registered_custom_properties", "statement_at_rules", "referenced_font_resources"]) {
    rows.set(key, { id: key, facets: { declarations: list(value[key], key) }, source: sourceAt(file, `/${key}`) });
  }
  return [...rows.values()];
}
export function themeRows(input: unknown, file: Evidence): InventoryRow[] {
  const value = object(input, file.path), rows = list(value.appearance_settings, "appearance_settings").map((raw, i) => {
    const setting = object(raw, "appearance setting");
    return { id: `setting:${string(setting.field, "field")}`, facets: { typeExpression: setting.schema_expression, defaultExpression: setting.default_expression,
      default: setting.default, storage: { key: setting.storage_key, kind: setting.storage_kind } }, source: sourceAt(file, `/appearance_settings/${i}`) } as InventoryRow;
  });
  for (const key of ["built_in_light_dark_palette", "chrome_theme_schema", "translucent_sidebar_control"]) rows.push({ id: key, facets: { declaration: value[key] }, source: sourceAt(file, `/${key}`) });
  return rows;
}
