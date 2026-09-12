import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseThemeFontFace, type LocalFontFace } from "../../../../packages/shared/src/appearance";

const FONT_FACES = `ObjC.import("AppKit");
var names = ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFonts);
JSON.stringify(names.map(function(name) {
  var font = $.NSFont.fontWithNameSize(name, 12);
  var members = ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableMembersOfFontFamily(font.familyName));
  var member = members.find(function(item) { return item[0] === name; });
  return { family: ObjC.unwrap(font.familyName), fullName: ObjC.unwrap(font.displayName), postscriptName: ObjC.unwrap(font.fontName), styleName: member ? member[1] : ObjC.unwrap(font.displayName), isMonospaced: Boolean(font.isFixedPitch) };
}));`;
export async function readLocalFontFaces(): Promise<LocalFontFace[]> {
  const { stdout } = await promisify(execFile)("/usr/bin/osascript", ["-l", "JavaScript", "-e", FONT_FACES], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const raw: unknown = JSON.parse(stdout);
  if (!Array.isArray(raw) || raw.length > 20_000) throw new Error("The local font face catalog could not be read.");
  return raw.map(item => {
    if (!item || typeof item !== "object" || typeof item.styleName !== "string" || item.styleName.length > 500 || typeof item.isMonospaced !== "boolean") throw new Error("Invalid local font style.");
    return { ...parseThemeFontFace({ family: item.family, fullName: item.fullName, postscriptName: item.postscriptName }), styleName: item.styleName, isMonospaced: item.isMonospaced };
  }).sort((a, b) => a.fullName.localeCompare(b.fullName));
}
