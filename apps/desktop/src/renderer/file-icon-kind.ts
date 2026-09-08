/** Filename and MIME presentation from pinned Codex7982 HV; independent of file ownership/opening. */
export type FileIconKind = "artifactDocument" | "code" | "document" | "file" | "css" | "cplusplus" | "folder" | "html" | "java" | "javascript" | "image" | "yaml" | "json" | "notebook" | "pdf" | "php" | "python" | "react" | "rust" | "shell" | "skill" | "spreadsheet" | "build" | "presentation" | "hashes" | "terminal" | "typescript" | "toml";
function extensionMap(groups: Partial<Record<FileIconKind,string>>): Readonly<Record<string,FileIconKind>> {
  return Object.fromEntries(Object.entries(groups).flatMap(([kind,extensions]) => extensions.split(" ").map(extension => [extension,kind as FileIconKind])));
}
const extensions = extensionMap({
  "typescript": "ts",
  "react": "tsx jsx",
  "javascript": "js mjs cjs hs",
  "python": "py",
  "java": "java",
  "rust": "rs",
  "php": "php",
  "css": "css scss less sass",
  "cplusplus": "cpp cxx cc c hpp hh h",
  "code": "rb go kt swift m mm cs sql",
  "json": "json jsonc",
  "document": "md mdx markdown mkd mdown xml env dotenv gitignore lock",
  "html": "html htm",
  "yaml": "yaml yml",
  "toml": "toml",
  "spreadsheet": "csv tsv xls xlsm xlsx",
  "artifactDocument": "doc docx",
  "notebook": "ipynb",
  "presentation": "ppt pptx",
  "shell": "sh bash zsh fish ps1",
  "terminal": "dockerfile",
  "image": "png jpg jpeg gif webp bmp svg ico",
  "build": "build bazel bzl ninja gradle mk makefile",
  "hashes": "sha sha1 sha256 md5 checksum sum",
  "pdf": "pdf",
  "folder": "zip gz tgz tar"
});
// Only MIME groups used by HV, resolved from the pinned MIME database with its source-precedence rules.
const mimeExtensions = extensionMap({
  "folder": "gz zip",
  "pdf": "pdf",
  "image": "wmf emf exr apng avci avcs avif bmp cgm drle fits g3 gif heic heics heif heifs hej2 hsj2 ief jls jp2 jpg2 jpeg jpg jpe jph jhc jpm jpx jpf jxr jxra jxrs jxs jxsc jxsi jxss ktx ktx2 png btif pti sgi svg svgz t38 tif tiff tfx psd azv uvi uvvi uvg uvvg djvu djv dwg dxf fbs fpx fst mmr rlc ico dds mdi wdp npx b16 tap vtf wbmp xif pcx webp 3ds ras cmx fh fhc fh4 fh5 fh7 jng sid pic pct pnm pbm pgm ppm rgb tga xbm xpm xwd",
  "document": "sub appcache manifest ics ifb coffee litcoffee css csv html htm shtml jade jsx less markdown md mml mdx n3 txt text conf def list log in ini dsc rtx sgml sgm shex slim slm spdx stylus styl tsv t tr roff man me ms ttl uri uris urls vcard curl dcurl mcurl scurl ged fly flx gv 3dml spot jad wml wmls vtt s asm c cc cxx cpp h hh dic htc f for f77 f90 hbs java lua mkd nfo opml p pas pde sass scss etx sfv ymp uu vcs vcf yaml yml"
});
export function fileIconKind(path?:string|null, mimeType?:string|null): FileIconKind {
  if (!path && !mimeType) return "file";
  if (path) {
    if (/[\\/]$/.test(path)) return "folder";
    const base = path.toLowerCase().split(/[\\/]/).at(-1)!;
    if (base === "skill.md") return "skill";
    const dot = base.lastIndexOf(".");
    const extension = dot > 0 && dot < base.length-1 ? base.slice(dot+1) : dot === 0 && base.length > 1 ? base.slice(1) : dot === -1 ? base : undefined;
    if (extension && Object.hasOwn(extensions,extension)) return extensions[extension]!;
  }
  if (mimeType != null) {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("text/")) return "document";
    if (mimeType.startsWith("application/pdf")) return "pdf";
    if (mimeType.startsWith("application/zip") || mimeType.startsWith("application/gzip")) return "folder";
    return "file";
  }
  // Equivalent to the pinned MIME lookup's POSIX extname("x." + path).
  const base = ("x." + (path ?? "")).toLowerCase().split("/").at(-1)!;
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot+1) : "";
  return Object.hasOwn(mimeExtensions,extension) ? mimeExtensions[extension]! : "file";
}
