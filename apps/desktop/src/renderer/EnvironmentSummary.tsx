import { useId, useState, type ReactNode } from "react";
import type { LocalEnvironmentAction, LocalEnvironmentConfig, LocalEnvironmentPlatform, LocalEnvironmentScript } from "@agent-desktop/shared";
import { HighlightedCode } from "./MarkdownText";
import { ActionIcon } from "./EnvironmentActions";
import { Icon } from "./Icons";

const platforms = ["default", "darwin", "linux", "win32"] as const;
type Platform = typeof platforms[number];
const label = (value: Platform) => value === "default" ? "Default" : value === "darwin" ? "macOS" : value === "win32" ? "Windows" : "Linux";

export function EnvironmentSummary({ config, dirty, error, onEdit, variables }: {
  config?: LocalEnvironmentConfig; dirty: boolean; error?: string; onEdit(): void; variables: ReactNode;
}) {
  return <div className="environment-summary">
    <header className="environment-summary-heading"><div><h1>{config?.name || "Environments"}</h1></div>
      <div className="environment-summary-edit">{dirty && <span>Unsaved changes</span>}<button type="button" className="secondary-button" aria-label="Edit local environment" onClick={onEdit}><Icon name="pencil"/>Edit</button></div>
    </header>
    {config ? <>
      <ScriptSummary kind="setup" script={config.setup} actions={variables}/>
      <ScriptSummary kind="cleanup" script={config.cleanup}/>
      <section className="environment-summary-section"><h2>Actions</h2><p>These actions can run any command and will be displayed in the header</p>
        <div className="environment-summary-rows">{config.actions?.length ? config.actions.map((action, index) => <ActionSummary key={`${index}:${action.name}`} action={action}/>) : <div className="environment-summary-empty">Add an action to run commands from the local toolbar</div>}</div>
      </section>
    </> : <p className="inline-error" role="alert" title={error}>{error ? "This environment file is invalid. Saving will replace its contents" : "The saved configuration is unavailable. Edit to inspect or repair it."}</p>}
  </div>;
}

function ScriptSummary({ kind, script, actions }: { kind: "setup" | "cleanup"; script?: LocalEnvironmentScript; actions?: ReactNode }) {
  const [platform, setPlatform] = useState<Platform>("default");
  const base = script?.script ?? "", override = platform === "default" ? undefined : script?.[platform as LocalEnvironmentPlatform]?.script;
  const content = platform === "default" ? base : override || base;
  const hasScript = Boolean(base || platforms.some(value => value !== "default" && script?.[value]?.script));
  const [copy, setCopy] = useState<{ content: string; status: string }>();
  return <section className="environment-summary-section">
    <div className="local-environment-section-heading"><div><h2>{kind === "setup" ? "Setup script" : "Cleanup script"}</h2><p>{kind === "setup" ? "This script runs on worktree creation" : "Runs at the project root before worktree cleanup"}</p></div>{actions}</div>
    {hasScript && <div className="local-environment-platforms" role="tablist" aria-label={`${kind} summary platform`}>{platforms.map(value => <button key={value} type="button" role="tab" aria-selected={platform === value} className={platform === value ? "selected" : ""} onClick={() => setPlatform(value)}>{label(value)}</button>)}</div>}
    {platform !== "default" && !override && base && <p className="environment-platform-fallback">No platform override. Using the default script</p>}
    {content ? <div className="environment-summary-code markdown-code-block"><div className="environment-summary-code-actions"><button type="button" aria-label="Copy code" onClick={async () => {
      try { await navigator.clipboard.writeText(content); setCopy({ content, status: "Copied" }); } catch { setCopy({ content, status: "Copy failed" }); }
    }}>{copy?.content === content ? copy.status : "Copy code"}</button></div><pre tabIndex={0} aria-label={`${label(platform)} ${kind} script`}><HighlightedCode code={content} language={platform === "win32" ? "text" : "bash"}/></pre></div>
      : <div className="environment-summary-rows"><div className="environment-summary-empty">{platform === "default" || !hasScript ? "No script configured" : "No script configured for this platform"}</div></div>}
  </section>;
}

function ActionSummary({ action }: { action: LocalEnvironmentAction }) {
  const [expanded, setExpanded] = useState(false), id = useId();
  const lines = action.command.trimEnd().split(/\r?\n/);
  return <div className="environment-summary-action"><div className="environment-summary-action-row"><ActionIcon icon={action.icon ?? "tool"}/><div><span>{action.name}</span><code>{lines[0]}</code></div>
    {lines.length > 1 && <button type="button" className="icon-button" aria-controls={id} aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} full command for ${action.name}`} onClick={() => setExpanded(!expanded)}><Icon name="chevron"/></button>}
  </div>{lines.length > 1 && <pre id={id} hidden={!expanded} className="environment-summary-full-command"><code>{action.command}</code></pre>}</div>;
}
