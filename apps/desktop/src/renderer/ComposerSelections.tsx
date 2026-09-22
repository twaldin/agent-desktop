import type { ReactNode, Ref } from "react";
import { SessionAccountChoices } from "./SessionAccountChoices";
import type { DesktopBridge, Draft, ModelChoice, OmpApprovalMode, SessionSummary } from "@agent-desktop/shared";
import { ComposerSelectionPopup, type ComposerSelectionPopupHandle } from "./ComposerSelectionPopup";
import { ComposerPermissions } from "./ComposerPermissions";
import { composerModelGroups, composerModelKey, composerSelection, type ComposerCatalogState } from "./composer-catalog";

export function ComposerSelections({ data, draft, session, disabled, onChange, connection, commandRef, sessionControlsNode, advancedControlsNode }: {
  connection?: { bridge: DesktopBridge; hostId: string; localHostId?: string; connected: boolean };
  commandRef?: Ref<ComposerSelectionPopupHandle>;
  sessionControlsNode?: ReactNode;
  advancedControlsNode?: ReactNode;
  data: ComposerCatalogState; draft: Draft; session?: SessionSummary | null; disabled: boolean;
  onChange(patch: { model?: ModelChoice | null; thinkingLevel?: string; approvalMode?: OmpApprovalMode }): void;
}) {
  const selection = composerSelection(draft, data.catalog, session, data.controls);
  const models = data.catalog?.models ?? [];
  const nativeModel = session ? selection.current : data.catalog?.default.model;
  const sessionLabel = data.connected && data.controls && !data.controlsError && !data.loading ? "Current session" : "Last reported session";
  const defaultLabel = session ? `${sessionLabel}${nativeModel ? `: ${nativeModel.id}` : " model unavailable"}` : data.catalog?.default.model ? `Native default: ${data.catalog.default.model.name}` : data.loading ? "Loading native default…" : data.catalog?.resolution === "legacy-capabilities" ? "Native default (older host; unresolved)" : "Native default at session start";
  const thinkingLabel = `${session ? sessionLabel : "Native default"}${selection.defaultThinking ? `: ${selection.defaultThinking}` : " reasoning"}`;
  const selectedTitle = [draft.model ? undefined : defaultLabel, selection.entry ? `${selection.entry.provider} · ${selection.entry.contextWindow?.toLocaleString() ?? "Unknown"} context` : undefined].filter(Boolean).join(" · ") || defaultLabel;
  return <>
    <ComposerPermissions draft={draft} catalog={data.catalog} session={session} controls={data.controls} disabled={disabled} onChange={approvalMode => onChange({ approvalMode })}/>
    {/* Session controls share the existing model popup, not the permission policy selector. */}
    <div className="composer-model-selections"><ComposerSelectionPopup commandRef={commandRef} sessionControlsNode={sessionControlsNode} advancedControlsNode={advancedControlsNode} accountChoicesNode={connection ? session ? <><SessionAccountChoices {...connection} session={session} disabled={disabled}/>{draft.model && (draft.model.provider !== session.model?.provider || draft.model.id !== session.model?.id) && <p>Your draft model applies on the next send. These accounts belong to the current session model.</p>}</> : <p>Start a conversation before choosing its native account. New conversations use the host’s native authentication.</p> : undefined} modelValue={composerModelKey(draft.model)} modelLabel={!draft.model ? selection.entry?.name ?? nativeModel?.id ?? (data.loading ? "Loading model…" : "Native default") : selection.entry?.name ?? draft.model.id} modelTitle={selectedTitle} disabled={disabled} effort={draft.thinkingLevel} effectiveEffort={selection.thinking} defaultEffortLabel={thinkingLabel} levels={selection.levels} models={[
      { value: "", label: session ? "Follow session" : "Default", detail: defaultLabel },
      ...(draft.model && !models.some(model => composerModelKey(model) === composerModelKey(draft.model)) ? [{ value: composerModelKey(draft.model), label: `${draft.model.id} (saved draft selection)`, provider: draft.model.provider }] : []),
      ...composerModelGroups(models).flatMap(([provider, group]) => group.map(model => ({ value: composerModelKey(model), provider, detail: `${provider} · ${model.id}${model.contextWindow ? ` · ${model.contextWindow.toLocaleString()} context` : ""}`, disabled: model.disabledInSettings || model.available === false, label: `${model.name}${model.disabledInSettings ? " · provider disabled" : model.available === false ? " · unavailable" : model.authenticated === false && model.available !== true ? " · sign-in required" : model.authenticated === undefined ? " · availability unknown" : ""}` }))),
    ]} onModel={value => { const model = models.find(item => composerModelKey(item) === value); onChange({ model: model ? { provider: model.provider, id: model.id } : value === "" ? null : draft.model, thinkingLevel: undefined }); }} onEffort={thinkingLevel => onChange({ thinkingLevel })} onReset={() => onChange({ model: null, thinkingLevel: undefined })}/></div>
  </>;
}
