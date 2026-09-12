export interface FileSearchLabelPart { text: string; isMatch: boolean }

/** Native command items bound display text by code points, not UTF-16 units. */
export function fileSearchDisplayText(value: string): string {
  if (value.length <= 100) return value;
  const points = Array.from(value);
  return points.length <= 100 ? value : `${points.slice(0, 99).join("").trimEnd()}…`;
}

/** Pinned tKo/f6: contiguous match wins; otherwise highlight the fuzzy subsequence.
 * These are query runs, not the tree's middle-truncated filename segments. */
export function fileSearchLabelParts(value: string, query: string): FileSearchLabelPart[] {
  const text = fileSearchDisplayText(value), points = Array.from(text), wanted = query.trim().toLowerCase();
  const lower = text.toLowerCase(), at = wanted ? lower.indexOf(wanted) : -1;
  const start = at < 0 ? -1 : Array.from(lower.slice(0, at)).length;
  const end = start < 0 ? -1 : start + Array.from(wanted).length;
  const fuzzy = at < 0 && wanted ? Array.from(wanted) : [];
  let matched = 0;
  const parts: FileSearchLabelPart[] = [];
  for (let index = 0; index < points.length; index++) {
    const character = points[index]!;
    const isMatch = !wanted || (start >= 0 ? index >= start && index < end : matched < fuzzy.length && character.toLowerCase() === fuzzy[matched]);
    if (start < 0 && isMatch && wanted) matched++;
    const previous = parts.at(-1);
    if (previous?.isMatch === isMatch) previous.text += character;
    else parts.push({ text: character, isMatch });
  }
  return parts;
}
