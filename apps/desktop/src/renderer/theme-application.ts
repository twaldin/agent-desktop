import { THEME_TOKEN_DEFINITIONS } from "../../../../packages/shared/src/preferences";
import { parseThemeDocument, type ThemeDocument } from "../../../../packages/shared/src/theme";

/** The shared parser excludes URLs, paths and arbitrary CSS from token values. */
export function themePresentation(input: ThemeDocument) {
  const document = parseThemeDocument(input);
  if (typeof CSS !== "undefined") {
    for (const [name, value] of Object.entries(document.tokens)) {
      const definition = THEME_TOKEN_DEFINITIONS[name as keyof typeof THEME_TOKEN_DEFINITIONS];
      if (definition.kind === "color" && !CSS.supports("color", value)) throw new Error(`This device cannot render the color for ${name}.`);
    }
    const colors = document.background.kind === "color" ? [document.background.color] : document.background.kind === "gradient" ? document.background.stops.map(stop => stop.color) : [];
    if (colors.some(color => !CSS.supports("color", color))) throw new Error("This device cannot render one of the background colors.");
  }
  const styles: Record<string, string> = { ...document.tokens };
  if (document.background.kind === "color") styles["--theme-background-color"] = document.background.color;
  else if (document.background.kind === "gradient") styles["--theme-background-image"] = `linear-gradient(${document.background.angle}deg, ${document.background.stops.map(stop => `${stop.color} ${stop.position * 100}%`).join(", ")})`;
  return { document, styles };
}
export function applyTheme(input: ThemeDocument, root: HTMLElement = document.documentElement) {
  const { document: theme, styles } = themePresentation(input);
  for (const name of [...Object.keys(THEME_TOKEN_DEFINITIONS), "--theme-background-color", "--theme-background-image"]) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(styles)) root.style.setProperty(name, value);
  root.dataset.theme = theme.mode; root.dataset.material = theme.material;
}
