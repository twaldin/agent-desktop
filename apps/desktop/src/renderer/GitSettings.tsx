import { useEffect, useState } from "react";
import type { PreferencesState } from "./preferences-state";

export function GitSettings({ preferences, onClose }: { preferences: PreferencesState; onClose(): void }) {
  const saved = preferences.get("git.branchPrefix") ?? "codex/";
  const [value, setValue] = useState(saved), [dirty, setDirty] = useState(false), [savedNotice, setSavedNotice] = useState(false);
  useEffect(() => { if (!dirty) setValue(saved); }, [saved, dirty]);
  const writable = preferences.connected && !preferences.busy && !preferences.pending.length;
  const save = async () => { await preferences.put({ key: "git.branchPrefix", value: value.trim() }); if (!preferences.error) { setDirty(false); setSavedNotice(true); } };
  return <section className="settings-page git-settings" aria-label="Git settings">
    <header className="settings-header"><button className="icon-button" aria-label="Close Git settings" onClick={onClose}>‹</button><div><h1>Git</h1><p>Branch and repository defaults</p></div><button className="primary-button" disabled={!writable || !dirty} onClick={() => void save()}>Save</button></header>
    <div className="theme-settings-scroll"><label className="settings-field" htmlFor="git-branch-prefix"><span>New branch prefix</span><input id="git-branch-prefix" aria-label="New branch prefix" value={value} onChange={event => { setValue(event.target.value); setDirty(true); setSavedNotice(false); }} placeholder="codex/"/></label><p className="settings-description">Used when creating a new branch. Leave empty to create branches without a prefix.</p>{savedNotice && <p className="settings-success" role="status">Git settings saved.</p>}{(preferences.error || preferences.cacheWarning) && <p className="inline-error" role="alert">{preferences.error ?? preferences.cacheWarning}</p>}</div>
  </section>;
}
