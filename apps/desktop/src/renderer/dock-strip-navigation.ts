/** Roving focus uses one ordered group, including the non-closeable leading Chat tab. */
export function dockStripFocusTarget(ids: readonly string[], current: string, key: string, direction: "ltr" | "rtl"): string | undefined {
  const index = ids.indexOf(current);
  if (index < 0 || !ids.length) return;
  if (key === "Home") return ids[0];
  if (key === "End") return ids.at(-1);
  if (key !== "ArrowLeft" && key !== "ArrowRight") return;
  const delta = (key === "ArrowRight" ? 1 : -1) * (direction === "rtl" ? -1 : 1);
  return ids[(index + delta + ids.length) % ids.length];
}
