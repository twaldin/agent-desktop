import { useId, useState } from "react";
import type { ProjectAppearance, ProjectAppearanceColor, ProjectAppearanceIcon } from "../../../../packages/shared/src/preferences";
import { PROJECT_APPEARANCE_COLORS, PROJECT_APPEARANCE_ICONS } from "../../../../packages/shared/src/preferences";
import { ProjectMarker, projectColor } from "./project-appearance";
import "./project-marker-picker.css";

export interface ProjectMarkerDraft {
  appearance?: ProjectAppearance;
  color?: ProjectAppearanceColor;
  customColor: string;
  emoji: string;
}
export type ProjectMarkerChange =
  | { kind: "color"; color: ProjectAppearanceColor }
  | { kind: "custom-color"; value: string }
  | { kind: "icon"; icon: ProjectAppearanceIcon }
  | { kind: "emoji"; value: string }
  | { kind: "reset" };
interface Props {
  projectName: string;
  draft: ProjectMarkerDraft;
  disabled?: boolean;
  onChange(change: ProjectMarkerChange): void;
}

/** A compact, native-popover project marker control for the project editor. */
export function ProjectMarkerPicker({ projectName, draft: { appearance, color, customColor, emoji }, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const selectedColor = color ?? "black";
  const selectedAppearance: ProjectAppearance = appearance ?? { marker: { kind: "icon", icon: "folder" }, color: selectedColor };
  return <div className="project-marker-control">
    <button type="button" className="project-marker-trigger" aria-label={`Change icon and color for ${projectName}`} aria-haspopup="dialog" aria-expanded={open} popoverTarget={id} disabled={disabled}>
      <ProjectMarker appearance={selectedAppearance}/><span className="project-marker-trigger-color" style={{ backgroundColor: projectColor(selectedColor) }}/>
    </button>
    <div id={id} popover="auto" className="project-marker-popover" aria-label="Project icon and color" onToggle={event => setOpen(event.newState === "open")}>
      <div className="project-marker-colors" aria-label="Project color">{PROJECT_APPEARANCE_COLORS.map(option => <button type="button" key={option} aria-label={`Use ${option} project color`} aria-pressed={selectedColor === option} className="project-color-swatch" style={{ backgroundColor: projectColor(option) }} disabled={disabled} onClick={() => onChange({ kind: "color", color: option })}/>)}</div>
      <label className="field-label" htmlFor={`${id}-custom-color`}>Custom hex color</label>
      <input id={`${id}-custom-color`} className="text-field" value={customColor} placeholder="#3B82F6" maxLength={7} disabled={disabled} onChange={event => onChange({ kind: "custom-color", value: event.target.value })}/>
      <div className="project-marker-icons" aria-label="Project icon">{PROJECT_APPEARANCE_ICONS.map(icon => <button type="button" key={icon} aria-label={`Use ${icon} icon`} aria-pressed={appearance?.marker.kind === "icon" && appearance.marker.icon === icon} disabled={disabled} onClick={() => onChange({ kind: "icon", icon })}><ProjectMarker appearance={{ marker: { kind: "icon", icon }, color: "black" }}/></button>)}</div>
      <label className="field-label" htmlFor={`${id}-emoji`}>Emoji</label>
      <input id={`${id}-emoji`} className="text-field" value={emoji} maxLength={32} disabled={disabled} onChange={event => onChange({ kind: "emoji", value: event.target.value })}/>
      <div className="project-marker-popover-actions"><button type="button" className="secondary-button project-marker-reset" disabled={disabled} onClick={() => onChange({ kind: "reset" })}>Reset icon and color</button><button type="button" className="secondary-button project-marker-done" aria-label="Done choosing project icon and color" popoverTarget={id} popoverTargetAction="hide">Done</button></div>
    </div>
  </div>;
}
