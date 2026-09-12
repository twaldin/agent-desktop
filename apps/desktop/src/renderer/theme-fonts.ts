import type { AppearanceFont } from "../../../../packages/shared/src/appearance";

const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
export const themeFontAlias = (font: NonNullable<AppearanceFont["face"]>) => `Agent Desktop selected ${font.postscriptName}`;
export function themeFontFamily(font: AppearanceFont): string | undefined {
  if (!font.family) return;
  return font.face ? `${quote(themeFontAlias(font.face))}, ${font.family}` : font.family;
}
const registered = new Map<string, Promise<void>>();
/** Browser-local faces only. Shared selections never import a font path or URL. */
export async function loadThemeFonts(fonts: AppearanceFont[]) {
  await Promise.all(fonts.map(font => {
    if (!font.face) return;
    const face = font.face, alias = themeFontAlias(face);
    const existing = registered.get(alias); if (existing) return existing;
    const native = new FontFace(alias, `local(${quote(face.postscriptName)}), local(${quote(face.fullName)})`);
    const loaded = native.load().then(value => { document.fonts.add(value); }, error => { registered.delete(alias); throw error; });
    registered.set(alias, loaded); return loaded;
  }));
}
