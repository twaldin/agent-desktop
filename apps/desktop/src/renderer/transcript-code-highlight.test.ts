import { describe, expect, test } from "bun:test";
import { HIGHLIGHT_LIMIT, highlightCode } from "./transcript-code-highlight";

function textOf(result: ReturnType<typeof highlightCode>): string | undefined {
  if (result.kind !== "highlighted") return undefined;
  const read = (nodes: typeof result.tree.children): string => nodes.map(node =>
    node.type === "text" ? node.value : node.type === "element" ? read(node.children) : "",
  ).join("");
  return read(result.tree.children);
}

describe("transcript fenced-code highlighting", () => {
  test("covers pinned languages outside Lowlight's common registry", () => {
    for (const [language, source] of [
      ["powershell", "$value = Get-Item ./file"],
      ["latex", "\\\\frac{a}{b}"],
      ["nginx", "server { listen 443 ssl; }"],
      ["pgsql", "SELECT payload::jsonb FROM events;"],
    ] as const) {
      const result = highlightCode(source, language);
      expect(result.kind).toBe("highlighted");
      expect(textOf(result)).toBe(source);
    }
  });

  test("supports native aliases including the explicit wolfram alias", () => {
    for (const [alias, source] of [
      ["js", "const answer = 42;"],
      ["tsx", "const node = <div />;"],
      ["py", "def answer(): return 42"],
      ["zsh", "echo $HOME"],
      ["html", "<strong>hello</strong>"],
      ["wolfram", "Plot[Sin[x], {x, 0, Pi}]"],
    ] as const) {
      const result = highlightCode(source, alias);
      expect(result.kind).toBe("highlighted");
      expect(textOf(result)).toBe(source);
    }
  });

  test("auto-detects an omitted language while preserving exact source", () => {
    const source = "def greet(name):\n    return f'Hello, {name}'";
    const result = highlightCode(source, "");
    expect(result.kind).toBe("highlighted");
    expect(result.kind === "highlighted" && result.tree.data?.language).toBeTruthy();
    expect(textOf(result)).toBe(source);
  });

  test("keeps explicit plain text and unknown languages readable", () => {
    expect(highlightCode("plain <text>", "text")).toEqual({ kind: "plain" });
    expect(highlightCode("still readable", "not-a-language")).toEqual({
      kind: "plain",
      reason: "No registered grammar for this language",
    });
  });

  test("does not highlight blocks beyond the synchronous work bound", () => {
    expect(highlightCode("x".repeat(HIGHLIGHT_LIMIT + 1), "javascript")).toEqual({
      kind: "plain",
      reason: "Large block displayed without highlighting",
    });
  });
});
