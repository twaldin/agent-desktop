import type { CSSProperties } from "react";
type IconName = "compose" | "search" | "folder" | "chevron" | "arrow" | "stop" | "more" | "archive" | "close" | "terminal" | "check" | "sidebar" | "plus" | "refresh" | "shield";
const paths: Record<IconName, React.ReactNode> = {
  shield: <path d="M10 2.5 16 5v5c0 3.2-2.5 5.6-6 7.5C6.5 15.6 4 13.2 4 10V5Z"/>,
  compose: <><path d="M11.5 4H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5"/><path d="m8 12 1-3L15.5 2.5a1.4 1.4 0 0 1 2 2L11 11l-3 1Z"/></>,
  search: <><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></>,
  folder: <path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h4l2 2h6A1.5 1.5 0 0 1 17.5 8v7A1.5 1.5 0 0 1 16 16.5H4A1.5 1.5 0 0 1 2.5 15Z"/>,
  chevron: <path d="m7.5 5 5 5-5 5"/>, arrow: <><path d="M10 16V4M5 9l5-5 5 5"/></>, stop: <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>,
  more: <><circle cx="4" cy="10" r="1" fill="currentColor"/><circle cx="10" cy="10" r="1" fill="currentColor"/><circle cx="16" cy="10" r="1" fill="currentColor"/></>,
  archive: <><rect x="3" y="3.5" width="14" height="4" rx="1"/><path d="M4.5 7.5v8a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-8M8 11h4"/></>,
  close: <path d="m5 5 10 10M15 5 5 15"/>, terminal: <><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="m5.5 7 3 3-3 3M10.5 13h4"/></>,
  check: <path d="m4 10 4 4 8-8"/>, sidebar: <><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M7.5 3.5v13"/></>,
  plus: <path d="M10 4v12M4 10h12"/>, refresh: <><path d="M16 8a6 6 0 1 0 .2 4M16 3.5V8h-4.5"/></>,
};
export function Icon({ name, className = "", style }: { name: IconName; className?: string; style?: CSSProperties }) {
  return <svg className={`icon ${className}`} style={style} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
