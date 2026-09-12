import type { WindowThemeEffects } from "../../../../packages/shared/src/theme";

/** Primary-window backdrop policy from the pinned macOS shell. Overlay windows
 * are not created by this desktop and do not share this policy. */
export function resolveWindowTheme(effects: WindowThemeEffects, context: {
  platform: string; focused: boolean; width: number; height: number; scaleFactor: number;
}) {
  if (!effects || !["none", "sidebar", "under-window", "hud"].includes(effects.material)
    || typeof effects.opaqueWindows !== "boolean"
    || typeof effects.backgroundColor !== "string"
    || !/^(#[\da-f]{6}|#[\da-f]{8}|rgba?\([\d.,%\s]+\)|transparent)$/i.test(effects.backgroundColor)) throw new Error("Invalid native window theme.");
  const color = /^#[\da-f]{8}$/i.test(effects.backgroundColor)
    ? `#${effects.backgroundColor.slice(7)}${effects.backgroundColor.slice(1, 7)}` : effects.backgroundColor;
  const longEdge = Math.max(context.width, context.height) * context.scaleFactor;
  const shortEdge = Math.min(context.width, context.height) * context.scaleFactor;
  const opaqueWindows = effects.opaqueWindows || context.platform !== "darwin"
    || !context.focused || (longEdge >= 3840 && shortEdge >= 2160);
  return { opaqueWindows, backgroundColor: opaqueWindows ? color : "#00000000",
    vibrancy: opaqueWindows ? null : effects.material === "none" ? "menu" as const : effects.material };
}
