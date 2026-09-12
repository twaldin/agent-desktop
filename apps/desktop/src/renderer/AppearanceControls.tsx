import { useLayoutEffect, useRef, useState } from "react";
import { appearanceFromTheme, type ThemeDocument } from "../../../../packages/shared/src/theme";
import { defaultChromeTheme, type Appearance, type ChromeTheme, type ThemeVariant, type LocalFontFace } from "../../../../packages/shared/src/appearance";
import { availablePresets, exportAppearanceTheme, importAppearanceTheme, presetChromeTheme } from "./appearance-presets";
import { appearanceColors } from "./appearance-colors";
import type { ThemeEditor } from "./theme-state";
import { AppearanceColor } from "./AppearanceColor";
import { AppearancePicker } from "./AppearancePicker";
import { NativeSwitch } from "./NativeSwitch";
import { Icon } from "./Icons";
import "./appearance-controls.css";

/** Normal controls commit immediately; the advanced token draft remains explicit. */
export function AppearanceControls({ data, fonts, fontFaces, backdropSupported, legacyReduceMotion }: { data: ThemeEditor; fonts: string[]; fontFaces: LocalFontFace[]; backdropSupported: boolean; legacyReduceMotion?: boolean }) {
  const read = () => { const value = appearanceFromTheme(data.draft); if (!data.draft.appearance && legacyReduceMotion !== undefined) value.reducedMotion = legacyReduceMotion ? "on" : "off"; return value; };
  const appearance = read();
  const disabled = data.loading || !data.current || Boolean(data.conflict) || data.manualDirty;
  const update = (patch: Partial<Appearance>) => { void data.commit({ ...data.draft, appearance: { ...read(), ...patch } }); };
  const paletteTokens = ["--app-surface", "--text", "--accent", "--ui-font", "--code-font"] as const;
  const overridden = paletteTokens.filter(name => data.draft.tokens[name] !== undefined);
  const variant = (mode: ThemeVariant, value: ChromeTheme) => { void data.commit({ ...data.draft, appearance: { ...read(), [mode]: value } }); };
  return <>
    <section className="appearance-theme-section" aria-labelledby="appearance-theme-title"><h2 id="appearance-theme-title">Theme</h2>
      <div className="appearance-preference-row"><label htmlFor="appearance-mode">Theme</label><select id="appearance-mode" disabled={disabled} value={data.draft.mode} onChange={event => void data.commit({ ...data.draft, mode: event.target.value as ThemeDocument["mode"] })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
      {overridden.length > 0 && <div className="theme-inline-warning"><p>Advanced overrides take precedence over these appearance controls in both light and dark themes: {overridden.join(", ")}.</p><button disabled={disabled} onClick={() => {
        const tokens = { ...data.draft.tokens }; for (const name of paletteTokens) delete tokens[name];
        void data.commit({ ...data.draft, tokens, appearance: read() });
      }}>Clear palette and font overrides for both themes</button></div>}
      <div className="appearance-variants">{(["light", "dark"] as const).map(mode => <VariantCard key={mode} variant={mode} value={appearance[mode]} disabled={disabled} backdropSupported={backdropSupported} fonts={fonts} fontFaces={fontFaces} onChange={value => variant(mode, value)}/>)}</div>
    </section>
    <section className="appearance-preferences" aria-labelledby="appearance-preferences-title"><h2 id="appearance-preferences-title">Preferences</h2>
      <div className="appearance-preference-row"><div><label htmlFor="appearance-ui-size">UI font size</label><p>Adjust the base size used across the interface</p></div><input id="appearance-ui-size" type="number" min={11} max={16} disabled={disabled} value={Number.parseFloat(data.draft.tokens["--font-size"] ?? "14")} onChange={event => { if (event.target.validity.valid && event.target.value) void data.commit({ ...data.draft, tokens: { ...data.draft.tokens, "--font-size": `${event.target.value}px` } }); }}/><span>px</span></div>
      <div className="appearance-preference-row"><div><label htmlFor="appearance-code-size">Code font size</label><p>Adjust the base size for code in chats and diffs</p></div><input id="appearance-code-size" type="number" min={8} max={24} disabled={disabled} value={Number.parseFloat(data.draft.tokens["--code-font-size"] ?? "12")} onChange={event => { if (event.target.validity.valid && event.target.value) void data.commit({ ...data.draft, tokens: { ...data.draft.tokens, "--code-font-size": `${event.target.value}px` } }); }}/><span>px</span></div>
      <div className="appearance-preference-row"><div><h3>Font smoothing</h3><p>Use native macOS font smoothing</p></div><NativeSwitch label="Font smoothing" checked={appearance.fontSmoothing} disabled={disabled} onChange={fontSmoothing => update({ fontSmoothing })}/></div>
      <div className="appearance-preference-row"><div><h3>Use pointer cursors</h3><p>Change the cursor when hovering over interactive elements</p></div><NativeSwitch label="Use pointer cursors" checked={appearance.pointerCursors} disabled={disabled} onChange={pointerCursors => update({ pointerCursors })}/></div>
      <div className="appearance-preference-row"><div><label htmlFor="appearance-motion">Reduce motion</label><p>Reduce animations or match your system</p></div><select id="appearance-motion" value={appearance.reducedMotion} disabled={disabled} onChange={event => update({ reducedMotion: event.target.value as Appearance["reducedMotion"] })}><option value="system">System</option><option value="on">On</option><option value="off">Off</option></select></div>
    </section>
  </>;
}
function VariantCard({ variant, value, fonts, fontFaces, disabled, backdropSupported, onChange }: { variant: ThemeVariant; value: ChromeTheme; fonts: string[]; fontFaces: LocalFontFace[]; disabled: boolean; backdropSupported: boolean; onChange(value: ChromeTheme): void }) {
  const title = variant === "light" ? "Light" : "Dark";
  const [copyStatus, setCopyStatus] = useState<string>(), [importOpen, setImportOpen] = useState(false), [importText, setImportText] = useState(""), [error, setError] = useState<string>();
  const importDialog = useRef<HTMLDialogElement>(null), importTrigger = useRef<HTMLButtonElement>(null);
  const closeImport = () => { setImportOpen(false); importDialog.current?.close(); importTrigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => { if (!importOpen || disabled) { importDialog.current?.close(); if (importOpen) setImportOpen(false); return; } const dialog = importDialog.current!; dialog.showModal(); return () => dialog.close(); }, [importOpen, disabled]);
  const colors = appearanceColors(value, variant);
  const patch = (changes: Partial<ChromeTheme>) => onChange({ ...value, ...changes });
  return <section className="appearance-variant" aria-label={`${title} theme`}>
    <header><h3>{title} theme</h3><button ref={importTrigger} disabled={disabled} aria-label={`Import ${variant} theme`} onClick={() => { setError(undefined); setImportText(""); setImportOpen(true); }}>Import</button><button aria-label={`Copy ${variant} theme`} onClick={() => { setCopyStatus(undefined); void navigator.clipboard.writeText(exportAppearanceTheme(value, variant)).then(() => setCopyStatus(`${title} theme copied`), () => setCopyStatus(`${title} theme could not be copied`)); }}>Copy theme</button></header>
    <div className="appearance-code-preview" style={{ background: value.surface, color: value.ink, borderColor: colors["--border"], fontFamily: value.fonts.code.family ?? "var(--code-font)" }} aria-hidden="true"><span style={{ color: value.accent }}>Aa</span><code><span style={{ color: value.semanticColors.skill }}>const</span> theme = <span style={{ color: value.semanticColors.diffAdded }}>"{availablePresets(variant).find(preset => preset[0] === value.codeThemeId)?.[1]}"</span></code></div>
    <div className="appearance-preset"><AppearancePicker label={`${title} code theme`} disabled={disabled} value={value.codeThemeId} options={availablePresets(variant).map(([id, label]) => ({ value: id, label }))} onChange={id => { const selected = availablePresets(variant).find(preset => preset[0] === id)?.[0]; if (selected) onChange(presetChromeTheme(selected, variant, value)); }}/></div>
    {([ ["accent", "Accent"], ["surface", "Background"], ["ink", "Foreground"] ] as const).map(([field, label]) => <div className="appearance-compact-row" key={field}><span>{label}</span><AppearanceColor label={`${title} ${label.toLowerCase()}`} disabled={disabled} value={value[field]} onChange={value => patch({ [field]: value })}/></div>)}

    {([ ["ui", "UI font"], ["content", "Content font"], ["code", "Code font"] ] as const).map(([role, label]) => {
      const font = value.fonts[role], family = font.family?.replace(/["']/g, "").toLowerCase();
      const faces = fontFaces.filter(face => face.family.toLowerCase() === family);
      const families = role === "code" && fontFaces.length ? fonts.filter(name => {
        const members = fontFaces.filter(face => face.family === name); return members.length > 0 && members.every(face => face.isMonospaced);
      }) : fonts;
      return <div className="appearance-font" key={role}><label htmlFor={`${variant}-${role}-font`}>{label}</label>
        <div className="appearance-font-controls"><AppearancePicker label={`${title} ${label.toLowerCase()}`} disabled={disabled} customValue={fonts.length === 0} searchable={fonts.length === 0} value={font.family ?? ""} options={[{ value: "", label: role === "content" ? "Same as UI font" : "System default" }, ...families.map(family => ({ value: `"${family}"`, label: family })), ...(font.family && !fonts.some(item => item.toLowerCase() === family) ? [{ value: font.family, label: `${font.family} (unavailable)` }] : [])]} onChange={family => patch({ fonts: { ...value.fonts, [role]: { family: family || null } } })}/>

        <AppearancePicker searchable={false} label={`${title} ${label.toLowerCase()} style`} disabled={disabled || !font.family || !faces.length || (role === "code" && !faces.every(face => face.isMonospaced))} value={font.face?.postscriptName ?? ""} options={[{ value: "", label: "Regular" }, ...faces.filter(face => face.styleName.toLowerCase() !== "regular").map(face => ({ value: face.postscriptName, label: face.styleName })), ...(font.face && !faces.some(face => face.postscriptName === font.face!.postscriptName) ? [{ value: font.face.postscriptName, label: `${font.face.fullName} (unavailable)` }] : [])]} onChange={postscriptName => {
          const selected = faces.find(face => face.postscriptName === postscriptName);
          const face = selected && { family: selected.family, fullName: selected.fullName, postscriptName: selected.postscriptName };
          patch({ fonts: { ...value.fonts, [role]: { family: font.family, ...(face ? { face } : {}) } } });
        }}/></div>{font.family && fonts.length > 0 && !fonts.some(item => item.toLowerCase() === family) && <small>This device may use a fallback font.</small>}
      </div>;
    })}
    <div className="appearance-compact-row"><span>Translucent sidebar</span><NativeSwitch label={`${title} translucent sidebar`} checked={!value.opaqueWindows} disabled={disabled || !backdropSupported} onChange={checked => patch({ opaqueWindows: !checked })}/></div>
    <div className="appearance-compact-row"><label htmlFor={`${variant}-contrast`}>Contrast</label><input id={`${variant}-contrast`} aria-label={`${title} contrast`} disabled={disabled} type="range" min={0} max={100} step={1} value={value.contrast} onChange={event => patch({ contrast: Number(event.target.value) })}/><output>{value.contrast}</output></div>
    {!backdropSupported && <p className="theme-inline-warning">Window translucency is unavailable on this desktop.</p>}
    <button className="appearance-reset" disabled={disabled} onClick={() => onChange(defaultChromeTheme(variant))}><Icon name="refresh"/>Reset {variant} theme</button>
    {copyStatus && <p className="appearance-notice" role="status">{copyStatus}</p>}
    {importOpen && <dialog ref={importDialog} className="appearance-import" aria-label={`Import ${variant} theme`} onCancel={event => { event.preventDefault(); closeImport(); }}>
      <h3>Import {variant} theme</h3><label htmlFor={`${variant}-import`}>Paste a theme share string</label><textarea autoFocus id={`${variant}-import`} value={importText} onChange={event => { setImportText(event.target.value); setError(undefined); }}/>{error && <p role="alert">{error}</p>}<div><button onClick={closeImport}>Cancel</button><button disabled={disabled || !importText.trim()} onClick={() => { try { onChange(importAppearanceTheme(importText, variant)); closeImport(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>Import theme</button></div>
    </dialog>}
  </section>;
}
