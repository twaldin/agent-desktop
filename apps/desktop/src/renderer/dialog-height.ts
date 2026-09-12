/** Mirror the pinned dialog's body measurement, including its next-frame ready
 * marker. This does not prescribe an animation curve: the shipped measurement
 * helper supplies no timing, and the corresponding CSS rule is unestablished. */
export function observeDialogHeight(content: HTMLElement, body: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  let measureFrame: number | undefined, readyFrame: number | undefined;
  let previous = -1, ready = false, active = true;
  const measure = () => {
    measureFrame = undefined;
    if (!active) return;
    const height = body.offsetHeight || body.scrollHeight;
    if (!Number.isFinite(height) || Math.abs(height - previous) < .5) return;
    previous = height;
    content.style.setProperty("--dialog-content-height", `${height}px`);
    content.style.height = "var(--dialog-content-height)";
    if (!ready) {
      if (readyFrame !== undefined) cancelAnimationFrame(readyFrame);
      readyFrame = requestAnimationFrame(() => {
        readyFrame = undefined;
        if (active) { ready = true; content.dataset.dialogHeightReady = "true"; }
      });
    }
  };
  const queue = () => { if (active && measureFrame === undefined) measureFrame = requestAnimationFrame(measure); };
  queue();
  const observer = new ResizeObserver(queue);
  observer.observe(body);
  return () => {
    active = false; observer.disconnect();
    if (measureFrame !== undefined) cancelAnimationFrame(measureFrame);
    if (readyFrame !== undefined) cancelAnimationFrame(readyFrame);
    content.style.removeProperty("--dialog-content-height");
    content.style.height = "";
    delete content.dataset.dialogHeightReady;
  };
}
