import type { ChromeTheme, ThemeVariant } from "../../../../packages/shared/src/appearance";
// Pinned chrome-theme arithmetic uses clamped, rounded sRGB component mixing.
type RGB = readonly [number, number, number];
const rgb = (hex: string): RGB => [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, amount: number): RGB => [0, 1, 2].map(i => Math.round(a[i]! + (b[i]! - a[i]!) * Math.max(0, Math.min(1, amount)))) as [number, number, number];
const hex = (value: RGB) => `#${value.map(part => part.toString(16).padStart(2, "0")).join("")}`;
const alpha = (value: RGB, opacity: number) => `rgba(${value.join(", ")}, ${Math.max(0, Math.min(1, opacity)).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")})`;
const white: RGB = [255, 255, 255];
export function appearanceColors(theme: ChromeTheme, variant: ThemeVariant): Record<string, string> {
  const dark = variant === "dark", baseline = dark ? 60 : 45;
  const scaled = theme.contrast / 100 + (theme.contrast - baseline) / 60 * .7;
  const contrast = theme.contrast <= baseline ? scaled : baseline / 100 + (scaled - baseline / 100) * 2;
  const surface = rgb(theme.surface), ink = rgb(theme.ink), accent = rgb(theme.accent);
  const control = dark ? mix(surface, ink, .06 + contrast * .05) : mix(surface, white, .09 + contrast * .04);
  const elevated = dark ? mix(surface, ink, .08 + contrast * .08) : mix(surface, white, .16 + contrast * .12);
  const panel = mix(surface, dark ? ink : white, (dark ? .03 : .18) + contrast * (dark ? .03 : .008));
  const menu = mix(surface, ink, .02 + contrast * .02);
  return {
    "--app-surface": theme.surface, "--sidebar-surface": hex(panel), "--composer-surface": hex(control), "--elevated-surface": hex(elevated),
    "--panel-surface": hex(panel), "--menu-surface": hex(menu), "--dialog-surface": alpha(elevated, .96), "--dialog-input-surface": hex(control),
    "--editor-surface": hex(dark ? mix(surface, ink, .07) : mix(surface, white, .12)), "--settings-card-surface": hex(mix(surface, ink, .05)),
    "--text": theme.ink, "--secondary": alpha(ink, .65 + contrast * .1), "--tertiary": alpha(ink, dark ? .42 + contrast * .13 : .45 + contrast * .1),
    "--accent": theme.accent, "--focus-ring": dark ? alpha(mix(accent, white, .3 + contrast * .15), .7 + contrast * .1) : theme.accent,
    "--border": alpha(ink, .06 + contrast * .04), "--hover": alpha(ink, (dark ? .05 : .08) + contrast * (dark ? .03 : .04)),
    "--selected": alpha(ink, (dark ? .07 : .16) + contrast * (dark ? .05 : .08)),
    "--header-divider-color": alpha(ink, .12 + contrast * .06), "--sidebar-divider-color": alpha(ink, .06 + contrast * .04),
    "--diff-added-text": theme.semanticColors.diffAdded, "--diff-removed-text": theme.semanticColors.diffRemoved,
    "--diff-added-surface": alpha(rgb(theme.semanticColors.diffAdded), dark ? .23 : .15), "--diff-removed-surface": alpha(rgb(theme.semanticColors.diffRemoved), dark ? .23 : .15),
    "--selection-surface": alpha(accent, .3),
  };
}
