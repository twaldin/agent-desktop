import type { Draft, OmpApprovalMode, OmpComposerCatalog, OmpSessionControls, SessionSummary } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import { CompactSelect } from "./CompactSelect";

export const approvalModes: Record<OmpApprovalMode, { label: string; description: string }> = {
  "always-ask": { label: "Always ask", description: "Ask before native write and execution tools." },
  write: { label: "Write", description: "Allow native writes; ask before execution tools." },
  yolo: { label: "Yolo", description: "Allow native tool tiers without a mode-level prompt." },
};
export function composerApproval(draft: Draft, catalog?: OmpComposerCatalog, session?: SessionSummary | null, controls?: OmpSessionControls) {
  const value = session ? controls?.settings.find(setting => setting.path === "tools.approvalMode")?.effective : catalog?.default.approvalMode;
  const current = typeof value === "string" && Object.hasOwn(approvalModes, value) ? value as OmpApprovalMode : undefined;
  return { current, effective: draft.approvalMode ?? current, supported: catalog?.default.approvalMode !== undefined,
    differs: Boolean(draft.approvalMode && current && draft.approvalMode !== current) };
}

export function ComposerPermissions({ draft, catalog, session, controls, disabled, onChange }: {
  draft: Draft; catalog?: OmpComposerCatalog; session?: SessionSummary | null; controls?: OmpSessionControls; disabled: boolean;
  onChange(mode: OmpApprovalMode | undefined): void;
}) {
  const choice = composerApproval(draft, catalog, session, controls);
  const label = choice.current ? `${session ? "Session" : "Default"}: ${approvalModes[choice.current].label}` : session ? "Follow current permissions" : "Native default permissions";
  const description = choice.effective ? `${approvalModes[choice.effective].description} Native per-tool policies still apply.` : "Native permissions have not loaded.";
  return <label className="select-control permission-select" title={`${description} ${draft.approvalMode ? "This draft applies its choice on send; the session keeps it across host restarts." : "Follow the native default for a new session or the current session's policy."}${!choice.supported ? " Update the owning host if permission controls remain unavailable." : ""}`}>
    <Icon name="shield"/><span className="sr-only">Permissions</span>
    <CompactSelect label="Permissions" displayValue={choice.effective ? approvalModes[choice.effective].label : "Permissions"} value={draft.approvalMode ?? ""} disabled={disabled || !choice.supported} onChange={value => onChange(value ? value as OmpApprovalMode : undefined)}>
      <option value="">{label}</option>
      {Object.entries(approvalModes).map(([mode, value]) => <option key={mode} value={mode}>{value.label}</option>)}
    </CompactSelect>
  </label>;
}
