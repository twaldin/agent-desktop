export interface RenderedDiagram { svg: string; width: number; height: number }

export function isSvgDiagram(code: string, language: string): boolean {
  return language === "svg" || (language === "xml" || language === "html") && /^\s*<svg/.test(code);
}
export function isMermaidDiagram(language: string, open: boolean): boolean {
  return language === "mermaid" || open && language.length >= 2 && "mermaid".startsWith(language.toLowerCase());
}

/** Pinned7982 strips interactive directives; only its sequence-number color survives init. */
export function prepareMermaid(code: string): string | undefined {
  let unsafe = false;
  const prepared = code.replace(/%%\{[\s\S]*?\}%%/g, directive => {
    if (/["']?securityLevel["']?\s*:/i.test(directive)) unsafe = true;
    const init = /^%%\{\s*(?:init|initialize)\s*:\s*(\{[\s\S]*\})\s*\}%%$/i.exec(directive);
    if (init) try {
      const value = JSON.parse(init[1]!.replaceAll("'", '"'));
      const variables = value?.themeVariables, color = variables?.sequenceNumberColor;
      if (value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).every(key => key === "theme" || key === "themeVariables")
        && (value.theme === undefined || value.theme === "base")
        && variables && typeof variables === "object" && !Array.isArray(variables)
        && Object.keys(variables).every(key => key === "sequenceNumberColor")
        && typeof color === "string" && /^#(?:[a-f0-9]{3}|(?:[a-f0-9]{2}){2,4})$/i.test(color)) {
        return `%%{init: ${JSON.stringify({ theme: "base", themeVariables: { sequenceNumberColor: color } })}}%%`;
      }
    } catch { /* Invalid initialization directives are discarded, not executed. */ }
    return "";
  });
  return unsafe ? undefined : prepared.replace(/^\s*click\s+.*$/gim, "").replaceAll("\\n", "<br/>");
}
