import { registerCustomTheme, type ThemeRegistration } from "@pierre/diffs";
import dark from "./review-theme-dark.json";
import light from "./review-theme-light.json";

// Full literal rule data from pinned 26.901.41600, statically parsed, not executed.
// Source hashes and renderer styling provenance: docs/panel-reference.md.
export const REVIEW_THEMES = { dark: "agent-review-dark", light: "agent-review-light" };
registerCustomTheme(REVIEW_THEMES.dark, async () => dark as ThemeRegistration);
registerCustomTheme(REVIEW_THEMES.light, async () => light as ThemeRegistration);

/** These overrides are passed inside Pierre's shadow root; outside app CSS cannot reach it. */
export const REVIEW_SHADOW_CSS = `
:host { --diffs-font-family:var(--code-font,monospace); --diffs-font-size:var(--code-font-size,12px); --diffs-line-height:calc(var(--code-font-size,12px) * 1.8); --diffs-gap-block:0; --diffs-min-number-column-width:4ch; }
pre { --diffs-bg:var(--app-surface,#181818); --diffs-bg-buffer:var(--app-surface,#181818); --diffs-selection-bg:var(--selection-surface,#2870bd55); margin:0; }
[data-separator] { font-family:var(--code-font,monospace); }
`;
