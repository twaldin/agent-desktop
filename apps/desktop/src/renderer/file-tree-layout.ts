import type { FileTreeView } from "../window-state";

export const fileTreeWidth = (width: number, container: number) => Math.min(Math.max(200, width), Math.max(200, container * .6));
export const fileTreeResize = (view: FileTreeView, requested: number, container: number): FileTreeView =>
  requested < 100 ? { ...view, open: false } : { open: true, width: fileTreeWidth(requested, container) };

