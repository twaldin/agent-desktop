import dockerfile from "highlight.js/lib/languages/dockerfile";
import dos from "highlight.js/lib/languages/dos";
import latex from "highlight.js/lib/languages/latex";
import mathematica from "highlight.js/lib/languages/mathematica";
import matlab from "highlight.js/lib/languages/matlab";
import nginx from "highlight.js/lib/languages/nginx";
import pgsql from "highlight.js/lib/languages/pgsql";
import powershell from "highlight.js/lib/languages/powershell";
import { common, createLowlight } from "lowlight";

export const HIGHLIGHT_LIMIT = 100_000;

const extra = {
  dockerfile,
  dos,
  powershell,
  latex,
  mathematica,
  matlab,
  nginx,
  pgsql,
};

const grammars = createLowlight({ ...common, ...extra });
grammars.registerAlias("mathematica", "wolfram");

export type TranscriptCodeHighlight =
  | { kind: "highlighted"; tree: ReturnType<typeof grammars.highlight>; reason?: undefined }
  | { kind: "plain"; reason?: string; tree?: undefined };

function sourceOf(nodes: ReturnType<typeof grammars.highlight>["children"]): string {
  return nodes.map(node => node.type === "text" ? node.value : node.type === "element" ? sourceOf(node.children) : "").join("");
}

/** Highlight a complete fenced-code source without ever changing or hiding its text. */
export function highlightCode(code: string, language: string): TranscriptCodeHighlight {
  if (code.length > HIGHLIGHT_LIMIT) return { kind: "plain", reason: "Large block displayed without highlighting" };

  const name = language.trim().toLowerCase();
  if (["text", "txt", "plaintext"].includes(name)) return { kind: "plain" };
  if (name && !grammars.registered(name)) return { kind: "plain", reason: "No registered grammar for this language" };

  try {
    const tree = name ? grammars.highlight(name, code) : grammars.highlightAuto(code);
    // Lowlight represents an inconclusive auto-detection as an empty tree. It is
    // only safe to render a highlighted result when it preserves the source.
    return sourceOf(tree.children) === code
      ? { kind: "highlighted", tree }
      : { kind: "plain", reason: name ? "The language grammar could not preserve this block" : undefined };
  } catch {
    return { kind: "plain", reason: "The language grammar could not highlight this block" };
  }
}
