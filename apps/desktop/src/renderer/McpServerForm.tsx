import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { NativeMcpDetail, NativeMcpMutation } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import { buildMcpServerConfig, readMcpServerForm, updateMcpServerConfig, type McpServerFormInput } from "./mcp-server-form";

type ValueRow = { id: string; value: string; touched: boolean };
type PairRow = { id: string; key: string; value: string };
const valueRow = (touched = false): ValueRow => ({ id: crypto.randomUUID(), value: "", touched });
const pairRow = (): PairRow => ({ id: crypto.randomUUID(), key: "", value: "" });
const focusRow = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

function ValueRows({ title, addLabel, rows, onChange, disabled }: {
  title: string; addLabel: string; rows: ValueRow[]; onChange(rows: ValueRow[]): void; disabled: boolean;
}) {
  return <section className="mcp-form-section" aria-label={title}><h3>{title}</h3>
    {rows.map((row, index) => <div className="mcp-entry" key={row.id}>
      <input id={row.id} className="text-field" aria-label={`${title} ${index + 1}`} value={row.value} disabled={disabled} spellCheck={false}
        onChange={event => onChange(rows.map(item => item.id === row.id ? { ...item, value: event.target.value, touched: true } : item))}/>
      <button type="button" className="mcp-remove-entry icon-button" aria-label={`Remove ${title.toLowerCase()} ${index + 1}`} title="Remove entry"
        disabled={disabled || rows.length === 1 && !row.touched && !row.value} onClick={() => {
          const next = rows.filter(item => item.id !== row.id); if (!next.length) next.push(valueRow());
          onChange(next); focusRow(next[Math.min(index, next.length - 1)]!.id);
        }}><Icon name="trash"/></button>
    </div>)}
    <button type="button" className="mcp-add-entry" disabled={disabled} onClick={() => { const next = valueRow(true); onChange([...rows, next]); focusRow(next.id); }}><Icon name="plus"/>{addLabel}</button>
  </section>;
}

function PairRows({ title, addLabel, rows, onChange, disabled, secret = false, environment = false }: {
  title: string; addLabel: string; rows: PairRow[]; onChange(rows: PairRow[]): void; disabled: boolean; secret?: boolean; environment?: boolean;
}) {
  return <section className="mcp-form-section" aria-label={title}><h3>{title}</h3>
    {rows.map((row, index) => <div className="mcp-entry mcp-pair-entry" key={row.id}>
      <input id={row.id} className="text-field" aria-label={`${title} key ${index + 1}`} placeholder="Key" value={row.key} disabled={disabled} spellCheck={false}
        onChange={event => onChange(rows.map(item => item.id === row.id ? { ...item, key: event.target.value } : item))}/>
      <input className="text-field" aria-label={`${title} value ${index + 1}`} placeholder={environment ? "Environment variable" : "Value"} type={secret ? "password" : "text"} autoComplete="off" value={row.value} disabled={disabled} spellCheck={false}
        onChange={event => onChange(rows.map(item => item.id === row.id ? { ...item, value: event.target.value } : item))}/>
      <button type="button" className="mcp-remove-entry icon-button" aria-label={`Remove ${title.toLowerCase()} ${index + 1}`} title="Remove entry"
        disabled={disabled || rows.length === 1 && !row.key && !row.value} onClick={() => {
          const next = rows.filter(item => item.id !== row.id); if (!next.length) next.push(pairRow());
          onChange(next); focusRow(next[Math.min(index, next.length - 1)]!.id);
        }}><Icon name="trash"/></button>
    </div>)}
    <button type="button" className="mcp-add-entry" disabled={disabled} onClick={() => { const next = pairRow(); onChange([...rows, next]); focusRow(next.id); }}><Icon name="plus"/>{addLabel}</button>
  </section>;
}

type Add = Extract<NativeMcpMutation, { operation: "add" }>;
type Update = Extract<NativeMcpMutation, { operation: "update" }>;
type SaveInput = Omit<Add, "expectedRevision"> | Omit<Update, "expectedRevision">;
export function McpServerForm({ active, disabled, hasProject, initial, onSave, onError, onDocs, onUninstall }: {
  active: boolean; disabled: boolean; hasProject: boolean; initial?: NativeMcpDetail; onSave(input: SaveInput): Promise<boolean>;
  onError(error: string | null): void; onDocs(): void; onUninstall?(): void;
}) {
  const seed = useMemo(() => initial ? readMcpServerForm(initial.config) : undefined, [initial]);
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => { if (active) nameField.current?.focus(); }, [active]);
  const [name, setName] = useState(initial?.server.name ?? ""); const [transport, setTransport] = useState<McpServerFormInput["transport"]>(seed?.transport ?? "stdio");
  const [command, setCommand] = useState(seed?.command ?? ""); const [url, setUrl] = useState(seed?.url ?? ""); const [cwd, setCwd] = useState(seed?.cwd ?? "");
  const values = (items?: string[]) => items?.length ? items.map(value => ({ ...valueRow(true), value })) : [valueRow()];
  const pairs = (items?: Array<{key:string;value:string}>) => items?.length ? items.map(item => ({ ...pairRow(), ...item })) : [pairRow()];
  const [args, setArgs] = useState<ValueRow[]>(() => values(seed?.args)); const [env, setEnv] = useState<PairRow[]>(() => pairs(seed?.env));
  const [envPassthrough, setEnvPassthrough] = useState<ValueRow[]>(() => values(seed?.envPassthrough));
  const [headers, setHeaders] = useState<PairRow[]>(() => pairs(seed?.headers)); const [headerEnv, setHeaderEnv] = useState<PairRow[]>(() => pairs(seed?.headerEnv));
  const [bearerTokenEnv, setBearerTokenEnv] = useState(seed?.bearerTokenEnv ?? ""); const [advanced, setAdvanced] = useState(seed?.advanced ?? "");
  const [advancedVisible, setAdvancedVisible] = useState(!initial);
  const [scope, setScope] = useState<"user" | "project">("user"); const submitting = useRef(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const input: McpServerFormInput = { transport, command, url, cwd, args: args.filter(row => row.touched || row.value).map(row => row.value),
    env: env.map(({key,value}) => ({key,value})), envPassthrough: envPassthrough.map(row => row.value),
    headers: headers.map(({key,value}) => ({key,value})), headerEnv: headerEnv.map(({key,value}) => ({key,value})), bearerTokenEnv, advanced };
  const baseline = useRef(JSON.stringify(input));
  const unchanged = Boolean(initial && JSON.stringify(input) === baseline.current);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (disabled || unchanged || submitting.current || !name.trim() || !(transport === "stdio" ? command : url).trim()) return;
    onError(null); setValidationError(null);
    let config: Record<string, unknown>;
    try { config = initial ? updateMcpServerConfig(initial.config, input) : buildMcpServerConfig(input); }
    catch (error) { setValidationError(error instanceof Error ? error.message : "The MCP configuration is invalid."); return; }
    submitting.current = true;
    try { await onSave(initial ? { operation: "update", serverId: initial.server.id, config } : { operation: "add", scope: hasProject ? scope : "user", name: name.trim(), config }); }
    finally { submitting.current = false; }
  };
  return <form className={`mcp-add${initial ? " mcp-edit" : ""}`} onSubmit={submit}>
    <div className="mcp-form-heading"><div className="mcp-form-title"><h2>{initial ? `Update ${initial.server.name} MCP` : "Connect to a custom MCP"}</h2>{initial && onUninstall && <button type="button" className="mcp-uninstall secondary-button" disabled={disabled} onClick={onUninstall}><Icon name="trash"/>Uninstall</button>}</div>{!initial && <button type="button" className="mcp-docs" onClick={onDocs}>Docs <Icon name="browserExternal"/></button>}</div>
    {initial ? <p className="integration-note mcp-transport-notice">If you would like to switch MCP server type, please uninstall first.</p> : <div className="mcp-form-group mcp-form-identity">
      <label className="mcp-form-section">Name<input ref={nameField} className="text-field" aria-label="MCP server name" placeholder="MCP server name" value={name} onChange={event => setName(event.target.value)} disabled={disabled}/></label>
      <div className="mcp-type-row"><span>Type</span><div className="integration-segments" role="group" aria-label="MCP server type">{(["stdio", "http", "sse"] as const).map(type => <button key={type} type="button" aria-pressed={transport === type} disabled={disabled} onClick={() => { setTransport(type); onError(null); }}>{type === "stdio" ? "STDIO" : type === "http" ? "Streamable HTTP" : "SSE"}</button>)}</div></div>
    </div>}
    <div className="mcp-form-group">
      {transport === "stdio" ? <>
        <label className="mcp-form-section">Command to launch<input ref={initial ? nameField : undefined} aria-label="Command to launch" className="text-field" placeholder="mcp-server" value={command} onChange={event => setCommand(event.target.value)} disabled={disabled} spellCheck={false}/></label>
        <ValueRows title="Arguments" addLabel="Add argument" rows={args} onChange={setArgs} disabled={disabled}/>
        <PairRows title="Environment variables" addLabel="Add environment variable" rows={env} onChange={setEnv} disabled={disabled} secret/>
        <ValueRows title="Environment variable passthrough" addLabel="Add variable" rows={envPassthrough} onChange={setEnvPassthrough} disabled={disabled}/>
        <label className="mcp-form-section">Working directory<input className="text-field" aria-label="Working directory" placeholder="Optional" value={cwd} onChange={event => setCwd(event.target.value)} disabled={disabled} spellCheck={false}/></label>
      </> : <>
        <label className="mcp-form-section">URL<input ref={initial ? nameField : undefined} aria-label="Server URL" className="text-field" placeholder="https://mcp.example.com/mcp" value={url} onChange={event => setUrl(event.target.value)} disabled={disabled} spellCheck={false}/></label>
        <label className="mcp-form-section">Bearer token env var<input className="text-field" aria-label="Bearer token env var" placeholder="MCP_BEARER_TOKEN" value={bearerTokenEnv} onChange={event => setBearerTokenEnv(event.target.value)} disabled={disabled} spellCheck={false}/></label>
        <PairRows title="Headers" addLabel="Add header" rows={headers} onChange={setHeaders} disabled={disabled} secret/>
        <PairRows title="Headers from environment variables" addLabel="Add variable" rows={headerEnv} onChange={setHeaderEnv} disabled={disabled} environment/>
      </>}
    </div>
    <details className="mcp-advanced"><summary>Additional settings</summary>
      {!initial && <label><span>Scope</span><select aria-label="MCP configuration scope" value={hasProject ? scope : "user"} onChange={event => setScope(event.target.value as "user" | "project")} disabled={disabled || !hasProject}><option value="user">User</option><option value="project">Project</option></select></label>}
      {advancedVisible ? <label><span>Native server configuration</span><textarea aria-label="Additional MCP settings" className="text-field" value={advanced} onChange={event => setAdvanced(event.target.value)} disabled={disabled} placeholder={'{"timeout": 30000}'}/></label> : <button type="button" className="secondary-button" disabled={disabled} onClick={() => setAdvancedVisible(true)}>Show native configuration</button>}
      <p className="integration-note">{initial ? "Saved native settings are preserved. Showing the configuration may reveal credentials. " : ""}Optional OMP settings. Fields shown above take precedence. Values use the owning host’s native environment and configuration rules.</p>
    </details>
    {validationError && <p className="inline-error" role="alert">{validationError}</p>}
    <button className="primary-button" type="submit" disabled={disabled || unchanged || !name.trim() || !(transport === "stdio" ? command : url).trim()}>Save</button>
  </form>;
}
