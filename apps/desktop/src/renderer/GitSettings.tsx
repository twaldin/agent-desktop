import { useEffect, useRef, useState } from "react";
import type { PreferencesState } from "./preferences-state";
import { Icon } from './Icons';

export function GitSettings({ preferences, onClose }: { preferences: PreferencesState; onClose(): void }) {
  const saved = preferences.get("git.branchPrefix") ?? "codex/";
  const [value, setValue] = useState(saved), [dirty, setDirty] = useState(false), [savedNotice, setSavedNotice] = useState(false);
  const editRevision = useRef(0);
  useEffect(() => { if (!dirty) setValue(saved); }, [saved, dirty]);
  const writable = preferences.connected && !preferences.busy && !preferences.pending.length;
  const save = async () => {
    if (!preferences.connected || preferences.busy || preferences.pending.length) return;
    const submitted = value.trim(), revision = editRevision.current;
    await preferences.put({ key: "git.branchPrefix", value: submitted });
    if (!preferences.error && !preferences.pending.length && preferences.get('git.branchPrefix') === submitted && editRevision.current === revision) {
      setDirty(false); setSavedNotice(true);
    }
  };
  return <section className="settings-page git-settings" aria-label="Git settings">
    <header className="settings-header"><button className="icon-button" aria-label="Close Git settings" onClick={onClose}><Icon name="browserBack"/></button><div><h1>Git</h1><p>Branch and repository defaults</p></div><button className="primary-button" disabled={!writable || !dirty} onClick={() => void save()}>Save</button></header>
    <div className="theme-settings-scroll"><label className="settings-field" htmlFor="git-branch-prefix"><span>New branch prefix</span><input id="git-branch-prefix" aria-label="New branch prefix" value={value} onChange={event => { editRevision.current++; setValue(event.target.value); setDirty(true); setSavedNotice(false); }} placeholder="codex/"/></label><p className="settings-description">Used when creating a new branch. Leave empty to create branches without a prefix.</p>{savedNotice && <p className="settings-success" role="status">Git settings saved.</p>}{(preferences.error || preferences.cacheWarning) && <p className="inline-error" role="alert">{preferences.error ?? preferences.cacheWarning}</p>}</div>
  </section>;
}
