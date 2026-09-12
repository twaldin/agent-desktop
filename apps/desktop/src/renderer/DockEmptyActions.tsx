import { DockActionIcon } from "./DockActionIcon";
import type { DockAddAction } from "./DockPanel";
import type { DockDestination } from "./dock-state";
import "./dock-empty-actions.css";

export interface DockEmptyActionsProps {
  /** The shell's action catalogue, rendered in the supplied order. */
  actions: readonly DockAddAction[];
  destination: DockDestination;
  /** Optional interception; the default activation is the action's own onSelect. */
  onSelect?(action: DockAddAction, destination: DockDestination): void;
}

/** The catalogue and activation owner are supplied by the shell, not inferred here. */
export function DockEmptyActions({ actions, destination, onSelect }: DockEmptyActionsProps) {
  // The source stays open with initial=false; it has no reachable enter/exit motion.
  // Static content also needs no alternate reduced-motion path.
  return <div className="dock-empty-panel-actions" data-dock-empty-actions={destination}>
    <div className="dock-empty-panel-content">
      <div className="dock-empty-panel-header">
        {actions.length
          ? <ul className="dock-empty-panel-list">
              {actions.map(action => <li key={action.id}>
                <button type="button" onClick={() => onSelect ? onSelect(action, destination) : action.onSelect(destination)}>
                  <span className="dock-empty-panel-icon"><DockActionIcon action={action}/></span>
                  <span className="dock-empty-panel-label">{action.label}</span>
                  {action.shortcut ? <span className="dock-empty-panel-shortcut"><kbd>{action.shortcut}</kbd></span> : null}
                </button>
              </li>)}
            </ul>
          : <div className="dock-empty-panel-note">No tabs are available for this chat</div>}
      </div>
    </div>
  </div>;
}
