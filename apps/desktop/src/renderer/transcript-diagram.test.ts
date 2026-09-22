import { expect, test } from "bun:test";
import { isMermaidDiagram, isSvgDiagram, prepareMermaid } from "./transcript-diagram";

test("only the reference SVG fence forms replace literal code", () => {
  expect(isSvgDiagram("unfinished", "svg")).toBe(true);
  expect(isSvgDiagram("  <svg><path/>", "html")).toBe(true);
  expect(isSvgDiagram("<svg/>", "xml")).toBe(true);
  expect(isSvgDiagram("<div><svg/></div>", "html")).toBe(false);
  expect(isSvgDiagram("<SVG/>", "xml")).toBe(false);
  expect(isSvgDiagram("<svg/>", "javascript")).toBe(false);
});

test("partial Mermaid language is a streaming transition, not a completed alias", () => {
  expect(isMermaidDiagram("me", true)).toBe(true);
  expect(isMermaidDiagram("MERMAID", true)).toBe(true);
  expect(isMermaidDiagram("m", true)).toBe(false);
  expect(isMermaidDiagram("me", false)).toBe(false);
  expect(isMermaidDiagram("MERMAID", false)).toBe(false);
  expect(isMermaidDiagram("mermaid", false)).toBe(true);
});

test("diagram directives cannot relax security or bind click actions", () => {
  expect(prepareMermaid("%%{init: {'securityLevel': 'loose'}}%%\nflowchart LR\nA-->B")).toBeUndefined();
  expect(prepareMermaid('%%{initialize: {"theme":"base","themeVariables":{"sequenceNumberColor":"#abc"}}}%%\nsequenceDiagram\nA->>B: hi'))
    .toBe('%%{init: {"theme":"base","themeVariables":{"sequenceNumberColor":"#abc"}}}%%\nsequenceDiagram\nA->>B: hi');
  expect(prepareMermaid('%%{init: {"themeCSS":"@import url(https://example.invalid)"}}%%\nflowchart LR\nA["line\\nbreak"] --> B\nclick A "https://example.invalid"'))
    .toBe('\nflowchart LR\nA["line<br/>break"] --> B\n');
  expect(prepareMermaid('%%{init: {"themeVariables":{"sequenceNumberColor":"url(https://example.invalid)"}}}%%\nflowchart LR\nA-->B'))
    .toBe('\nflowchart LR\nA-->B');
});
