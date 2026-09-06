import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "./Icons";
import "./settings-sidebar.css";

import type { SettingsPage } from "../window-state";
export type { SettingsPage } from "../window-state";

type SettingsItem = { id: SettingsPage; label: string; group: "Personal" | "Integrations" | "Coding"; icon: "shield" | "sliders" | "branch" | "laptop" | "folder"; description: string };

const settingsItems: SettingsItem[] = [
  { id: "accounts", label: "Accounts", group: "Personal", icon: "shield", description: "Provider accounts and sign-in" },
  { id: "appearance", label: "Appearance", group: "Personal", icon: "sliders", description: "Theme and window appearance" },
  { id: "omp", label: "OMP", group: "Coding", icon: "laptop", description: "Native OMP configuration" },
  { id: "git", label: "Git", group: "Coding", icon: "branch", description: "Branch and repository defaults" },
  { id: "environments", label: "Environments", group: "Coding", icon: "folder", description: "Project setup environments" },
  { id: "plugins", label: "Plugins", group: "Integrations", icon: "folder", description: "Native OMP plugins and features" },
];

export interface SettingsSidebarProps {
  page: SettingsPage;
  onSelect(page: SettingsPage): void;
  onBack(): void;
  hostControl?: ReactNode;
  environmentAvailable?: boolean;
}

export function SettingsSidebar({ page, onSelect, onBack, hostControl, environmentAvailable = false }: SettingsSidebarProps) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const search = query.trim().toLowerCase();
    return settingsItems.filter(item => item.id !== "environments" || environmentAvailable).filter(item => !search || `${item.label} ${item.description}`.toLowerCase().includes(search));
  }, [environmentAvailable, query]);
  return <aside className="settings-sidebar" aria-label="Settings navigation">
    <div className="settings-sidebar-titlebar drag-region" aria-hidden="true"/>
    <button className="settings-sidebar-back" type="button" onClick={onBack}>
      <Icon name="browserBack" />
      <span>Back to app</span>
    </button>
    {hostControl && <div className="settings-sidebar-host">{hostControl}</div>}
    <label className="settings-sidebar-search">
      <Icon name="search" />
      <span className="sr-only">Search settings</span>
      <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search settings…" aria-label="Search settings" />
    </label>
    <nav className="settings-sidebar-nav">
      {(["Personal", "Integrations", "Coding"] as const).map(group => {
        const items = visible.filter(item => item.group === group);
        if (!items.length) return null;
        return <section key={group} aria-labelledby={`settings-sidebar-${group.toLowerCase()}`}>
          <h2 id={`settings-sidebar-${group.toLowerCase()}`}>{group}</h2>
          {items.map(item => <button key={item.id} type="button" className={`settings-sidebar-item ${(item.id === page || item.id === "plugins" && page === "mcp") ? "selected" : ""}`} aria-current={(item.id === page || item.id === "plugins" && page === "mcp") ? "page" : undefined} title={item.description} onClick={() => onSelect(item.id)}>
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>)}
        </section>;
      })}
      {!visible.length && <p className="settings-sidebar-empty">No settings match your search.</p>}
    </nav>
  </aside>;
}
