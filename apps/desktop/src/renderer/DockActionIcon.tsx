import { Icon } from "./Icons";
import type { DockAddAction } from "./DockPanel";

/** One action glyph is shared by the empty launcher and Open panel menu. */
export function DockActionIcon({ action }: { action: DockAddAction }) {
  if (action.id === "files") {
    return <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.67 4.67v-1c0-.92.75-1.67 1.67-1.67h1.27c.35 0 .67.1.97.31l.66.47c.29.21.61.3.97.3H13c.92 0 1.67.75 1.67 1.67V9c0 .92-.75 1.67-1.67 1.67h-1.67"/>
      <path d="M3 4.67h1.27c.35 0 .68.1.97.31l.66.47c.29.21.62.3.97.3h2.8c.92 0 1.66.75 1.66 1.67v4.25c0 .92-.74 1.66-1.66 1.66H3c-.92 0-1.67-.74-1.67-1.66V6.33c0-.92.75-1.66 1.67-1.66Z"/>
    </svg>;
  }
  if (action.id === "review") {
    return <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.67" y="2.67" width="10.66" height="10.66" rx="1.87"/>
      <path d="M8 5v3.33M6.33 6.67h3.34M6.33 10.67h3.34"/>
    </svg>;
  }
  return <Icon name={action.icon}/>;
}

