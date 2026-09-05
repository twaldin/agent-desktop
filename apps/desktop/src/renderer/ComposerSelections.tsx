import type { Draft, ModelChoice, OmpApprovalMode, SessionSummary } from "@agent-desktop/shared";
import { ModelPicker } from "./ModelPicker";
import { ComposerPermissions } from "./ComposerPermissions";
import { CompactSelect } from "./CompactSelect";
import { composerModelGroups, composerModelKey, composerSelection, type ComposerCatalogState } from "./composer-catalog";

export function ComposerSelections({ data, draft, session, disabled, onChange }: {
  data: ComposerCatalogState; draft: Draft; session?: SessionSummary | null; disabled: boolean;
  onChange(patch: { model?: ModelChoice | null; thinkingLevel?: string; approvalMode?: OmpApprovalMode }): void;
}) {
  const selection = composerSelection(draft, data.catalog, session, data.controls);
  const models = data.catalog?.models ?? [];
  const nativeModel = session ? selection.current : data.catalog?.default.model;
  const defaultLabel = session ? `Current session${nativeModel ? `: ${nativeModel.id}` : " model"}` : data.catalog?.default.model ? `Native default: ${data.catalog.default.model.name}` : data.loading ? "Loading native default…" : data.catalog?.resolution === "legacy-capabilities" ? "Native default (older host; unresolved)" : "Native default at session start";
  const thinkingLabel = `${session ? "Current session" : "Native default"}${selection.defaultThinking ? `: ${selection.defaultThinking}` : " reasoning"}`;
  const selectedTitle = [draft.model ? undefined : defaultLabel, selection.entry ? `${selection.entry.provider} · ${selection.entry.contextWindow?.toLocaleString() ?? "Unknown"} context` : undefined].filter(Boolean).join(" · ") || defaultLabel;
  return <>
    <ComposerPermissions draft={draft} catalog={data.catalog} session={session} controls={data.controls} disabled={disabled} onChange={approvalMode => onChange({ approvalMode })}/>
    <div className="composer-model-selections">
    <div className="select-control model-select"><ModelPicker label="Model" value={composerModelKey(draft.model)} disabled={disabled} title={selectedTitle} displayValue={!draft.model ? selection.entry?.name ?? nativeModel?.id ?? (data.loading ? "Loading model…" : "Native default") : undefined} options={[
      { value: "", label: defaultLabel },
      ...(draft.model && !models.some(model => composerModelKey(model) === composerModelKey(draft.model)) ? [{ value: composerModelKey(draft.model), label: `${draft.model.id} (saved draft selection)`, provider: draft.model.provider }] : []),
      ...composerModelGroups(models).flatMap(([provider, group]) => group.map(model => ({ value: composerModelKey(model), provider, detail: `${model.id} · ${model.contextWindow?.toLocaleString() ?? "Unknown"} context`, disabled: model.disabledInSettings || model.available === false,
        label: `${model.name}${model.disabledInSettings ? " · provider disabled" : model.available === false ? " · unavailable" : model.authenticated === false && model.available !== true ? " · sign-in required" : model.authenticated === undefined ? " · availability unknown" : ""}` }))),
    ]} onChange={value => { const model = models.find(item => composerModelKey(item) === value); onChange({ model: model ? { provider: model.provider, id: model.id } : value === "" ? null : draft.model, thinkingLevel: undefined }); }}/></div>
    {(selection.reasoning || draft.thinkingLevel) && <label className="select-control reasoning-select" title={selection.effectiveDefaultThinking ? `${thinkingLabel}. Native default resolves to ${selection.effectiveDefaultThinking}${selection.defaultThinking === "auto" ? " until automatic turn selection" : ""}` : thinkingLabel}><span className="sr-only">Reasoning effort</span><CompactSelect label="Reasoning effort" displayValue={selection.thinking ?? "Default"} value={draft.thinkingLevel ?? ""} disabled={disabled} onChange={value => onChange({ thinkingLevel: value || undefined })}><option value="">{thinkingLabel}</option>{selection.levels.map(level => <option key={level} value={level}>{level}</option>)}{draft.thinkingLevel && !selection.levels.includes(draft.thinkingLevel) && <option value={draft.thinkingLevel}>{draft.thinkingLevel} (saved)</option>}</CompactSelect></label>}
    </div>
  </>;
}
