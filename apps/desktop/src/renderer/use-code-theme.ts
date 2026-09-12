import { useEffect, useMemo, useState } from "react";
import { reviewThemeName } from "./review-theme";

/** Observe the applied theme, including system changes and both preset choices. */
export function useCodeTheme() {
  const read = () => {
    const root = document.documentElement;
    const variant = root.dataset.resolvedTheme ?? (root.dataset.theme === "system" || !root.dataset.theme
      ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : root.dataset.theme);
    return `${variant}|${root.dataset.codeThemeLight ?? ""}|${root.dataset.codeThemeDark ?? ""}`;
  };
  const [key, setKey] = useState(read);
  useEffect(() => {
    const change = () => setKey(read());
    const observer = new MutationObserver(change);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-resolved-theme", "data-code-theme-light", "data-code-theme-dark"] });
    const media = matchMedia("(prefers-color-scheme: dark)"); media.addEventListener("change", change);
    change(); return () => { observer.disconnect(); media.removeEventListener("change", change); };
  }, []);
  return useMemo(() => {
    const [variant, light, dark] = key.split("|");
    return { themeType: variant === "dark" ? "dark" as const : "light" as const,
      themes: { light: reviewThemeName(light, "light"), dark: reviewThemeName(dark, "dark") } };
  }, [key]);
}
