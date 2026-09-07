import { expect, test } from "bun:test";
import { markdownImagePath, parseMarkdownImages } from "./markdown-images";

const image = (href: string) => markdownImagePath(href, "docs/guide.md", "/owner/project");
test("images resolve against the owning Markdown file and preserve encoded filename bytes", () => {
  expect(image("../assets/wide.svg")).toBe("assets/wide.svg");
  expect(image("./a%20b.png")).toBe("docs/a b.png");
  expect(image("file:///owner/project/assets/small.png")).toBe("assets/small.png");
  expect(image("/owner/project/assets/no-extension")).toBe("assets/no-extension");
  expect(image("a%23b%3Fc.png")).toBe("docs/a#b?c.png");
});
test("web images and unresolved or escaping image paths remain source markup", () => {
  for (const href of ["", "https://example.com/image.png", "data:image/png;base64,AA==", "//other/image.png", "../../private.png", "file://another/owner/project/a.png", "file:///other/a.png", "bad%ZZ.png", "a\\ b.png", "a\nb.png", "#diagram", "😀.png", "%F0%9F%98%80.png"])
    expect(image(href)).toBeNull();
});
test("inline and reference image definitions use CommonMark decoding and first-definition ownership", () => {
  const text = '![A &amp; B](<images/a b.png> "A &quot;title&quot;")\n\n![Label][LoGo]\n\n![logo][]\n\n![logo]\n\n[logo]: small.svg "First"\n[logo]: other.svg\n\n![unknown][absent]';
  const images = [...parseMarkdownImages(text).values()];
  expect(images.map(({ href, alt, title }) => ({ href, alt, title }))).toEqual([
    { href: "images/a b.png", alt: "A & B", title: 'A "title"' },
    { href: "small.svg", alt: "Label", title: "First" },
    { href: "small.svg", alt: "logo", title: "First" },
    { href: "small.svg", alt: "logo", title: "First" },
  ]);
  expect(parseMarkdownImages('```md\n![code](a.png)\n```\n\n![multi\nline](a.png)').size).toBe(0);
});
