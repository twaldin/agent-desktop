import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PROJECT_APPEARANCE_ICONS } from "../../../../packages/shared/src/preferences";
import { ProjectMarker, projectAppearanceGlyphNames } from "./project-appearance";

test("every pinned project icon renders its concrete SVG glyph", () => {
  expect([...projectAppearanceGlyphNames].sort()).toEqual([...PROJECT_APPEARANCE_ICONS].sort());
  for (const icon of PROJECT_APPEARANCE_ICONS) {
    const markup = renderToStaticMarkup(<ProjectMarker appearance={{ marker: { kind: "icon", icon }, color: "purple" }} />);
    expect(markup).toContain("<svg");
    expect(markup).toContain("<path");
    expect(markup).not.toContain("project-marker-word");
  }
});

test("emoji project marker remains an emoji", () => {
  expect(renderToStaticMarkup(<ProjectMarker appearance={{ marker: { kind: "emoji", emoji: "🪴" }, color: "green" }} />)).toContain("🪴");
});
