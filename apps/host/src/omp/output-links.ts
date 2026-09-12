/** Explicit Markdown output links, excluding image syntax and fenced/inline
 * examples. The source contract includes nested labels and balanced targets. */
export function outputDocumentLinks(text: string): string[] {
  const targets: string[] = [];
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] === '`') {
        const ticks = /^`+/.exec(line.slice(i))![0], end = line.indexOf(ticks, i + ticks.length);
        if (end >= 0) { i = end + ticks.length - 1; continue; }
      }
      if (line[i] !== '[') continue;
      const image = line[i - 1] === '!', label = balanced(line, i, '[', ']');
      if (!label || line[label.end] !== '(') continue;
      const target = balanced(line, label.end, '(', ')');
      if (!target) continue;
      i = target.end - 1;
      if (image) continue;
      const value = target.value.trim();
      const destination = value.startsWith('<') ? /^<([^<>]+)>\s*(?:["'].*["'])?$/.exec(value)?.[1]
        : /^(.*?)(?:\s+["'].*["'])?$/.exec(value)?.[1];
      if (destination) targets.push(destination);
    }
  }
  return targets;
}
function balanced(line: string, start: number, open: string, close: string): { value: string; end: number } | undefined {
  let depth = 1, value = '';
  for (let i = start + 1; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && line[i + 1]) { value += line[++i]; continue; }
    if (ch === open) depth++;
    if (ch === close && --depth === 0) return { value, end: i + 1 };
    value += ch;
  }
}
export function declaredWebsite(text: string): string | undefined {
  const urls = new Set<string>();
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>)"'`]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[.,;!?]+$/, ''));
      if (url.href.length <= 8192 && url.port && !url.username && !url.password && !/[()[\]]/.test(`${url.pathname}${url.search}${url.hash}`)) urls.add(url.href);
    } catch { /* A malformed reference is not an output. */ }
  }
  return urls.size === 1 ? [...urls][0] : undefined;
}
