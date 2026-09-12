import { FileTypeIcon } from "./FileTypeIcon";
import { GoalIcon } from "./GoalIcons";
import { Icon } from "./Icons";
import type { DockTab } from "./dock-state";

/** The strip and address suggestions show the same destination artwork. */
export function DockTabIcon({tab}:{tab:DockTab}) {
  return tab.kind === "file" ? <FileTypeIcon path={tab.filePath}/> : tab.kind === "goal" ? <GoalIcon name="goal" className="icon"/>
    : <Icon name={tab.kind === "side-chat" ? "sideChat" : tab.kind === "browser" ? "globe" : tab.kind === "terminal" ? "terminal" : tab.kind === "review" ? "compose" : "folder"}/>;
}
