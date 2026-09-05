import type { NativeTerminalInput } from "../../../../packages/shared/src/terminals";
import { TerminalError } from "./error";

const NATIVE_KEY = /^(?:(?:C|M|S)-){0,3}(?:Up|Down|Left|Right|Home|End|IC|DC|PPage|NPage|BSpace|Enter|Tab|BTab|Escape|Space|F(?:[1-9]|[1-5][0-9]|6[0-3])|KP(?:[0-9]|Enter|[/*+.,=-])|[a-zA-Z0-9@\[\]\\^_?])$/;
export function validateNativeInput(input: NativeTerminalInput): void {
  if (!input || typeof input !== "object") throw new TerminalError("INVALID_TERMINAL_INPUT", "A typed terminal input source is required.");
  const keys: Record<NativeTerminalInput["kind"], string[]> = { text: ["kind", "data"], bytes: ["kind", "base64"], key: ["kind", "key"], paste: ["kind", "data"], mouse: ["kind", "button", "col", "row", "release"] };
  if (!Object.hasOwn(keys, input.kind) || Object.keys(input).some(key => !keys[input.kind].includes(key))) throw new TerminalError("INVALID_TERMINAL_INPUT", "Unexpected terminal input fields.");
  if (input.kind === "key") {
    if (typeof input.key !== "string" || !NATIVE_KEY.test(input.key)) throw new TerminalError("INVALID_TERMINAL_KEY", "This native key is not in the terminal key allowlist.");
  } else if (input.kind === "mouse") {
    if (![input.col, input.row, input.button].every(Number.isSafeInteger) || input.col < 1 || input.col > 400 || input.row < 1 || input.row > 200 || input.button < 0 || input.button > 255 || typeof input.release !== "boolean") throw new TerminalError("INVALID_TERMINAL_MOUSE", "The terminal mouse event has invalid button bits or cell coordinates.");
  } else {
    const data = input.kind === "bytes" ? input.base64 : input.data;
    if (typeof data !== "string" || (input.kind === "bytes" && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || Buffer.from(data, "base64").toString("base64") !== data)) || Buffer.byteLength(data, input.kind === "bytes" ? "base64" : "utf8") > 65_536) throw new TerminalError("INVALID_TERMINAL_INPUT", "Terminal input must be valid text or canonical base64 containing at most 64 KiB.");
  }
}
export function nativeInputIdentity(input: NativeTerminalInput): unknown[] {
  if (input.kind === "mouse") return [input.kind, input.button, input.col, input.row, input.release];
  if (input.kind === "key") return [input.kind, input.key];
  if (input.kind === "bytes") return [input.kind, input.base64];
  return [input.kind, input.data];
}
function hex(pane: string, bytes: Uint8Array): string {
  const commands: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4096) commands.push(`send-keys -t ${pane} -H ${Array.from(bytes.subarray(offset, offset + 4096), byte => byte.toString(16).padStart(2, "0")).join(" ")}`);
  return commands.join(" ; ") || "display-message -p AGENT_EMPTY_INPUT";
}
const conditional = (pane: string, condition: string, yes: string, no = "") => `if-shell -F -t ${pane} '${condition}' { ${yes} }${no ? ` { ${no} }` : ""}`;
/** All command syntax comes from this module; untrusted text is only represented as literal hex. */
export function nativeInputCommand(pane: string, cols: number, rows: number, input: NativeTerminalInput): string {
  if (!/^%[0-9]+$/.test(pane)) throw new Error("Invalid native pane identity.");
  validateNativeInput(input);
  let command: string;
  if (input.kind === "key") command = `send-keys -t ${pane} '${input.key}'`;
  else if (input.kind === "paste") {
    const text = Buffer.from(input.data.replace(/\r\n|\n/g, "\r"));
    command = conditional(pane, "#{bracket_paste_flag}", hex(pane, Buffer.concat([Buffer.from("\x1b[200~"), text, Buffer.from("\x1b[201~")])), hex(pane, text));
  } else if (input.kind === "mouse") {
    const { button, col, row, release } = input;
    if (col > cols || row > rows) throw new TerminalError("STALE_TERMINAL_GEOMETRY", "The mouse event lies outside the accepted terminal grid.");
    const legacyButton = release ? (button & ~3) | 3 : button;
    const sgr = Buffer.from(`\x1b[<${button};${col};${row}${release ? "m" : "M"}`);
    const legacy = Buffer.from([27, 91, 77, legacyButton + 32, Math.min(255, col + 32), Math.min(255, row + 32)]);
    const utf8 = Buffer.from("\x1b[M" + String.fromCharCode(legacyButton + 32, col + 32, row + 32));
    const tracking = button & 32 ? (button & 3) === 3 ? "#{mouse_all_flag}" : "#{||:#{mouse_all_flag},#{mouse_button_flag}}" : "#{mouse_any_flag}";
    command = conditional(pane, tracking, conditional(pane, "#{mouse_sgr_flag}", hex(pane, sgr), conditional(pane, "#{mouse_utf8_flag}", hex(pane, utf8), hex(pane, legacy))));
  } else command = hex(pane, Buffer.from(input.kind === "bytes" ? input.base64 : input.data, input.kind === "bytes" ? "base64" : "utf8"));
  return conditional(pane, `#{&&:#{==:#{pane_width},${cols}},#{==:#{pane_height},${rows}}}`, command, "display-message -p AGENT_STALE_GEOMETRY");
}
