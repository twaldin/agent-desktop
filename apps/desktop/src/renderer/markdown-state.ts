/** Only view preferences; code and clipboard contents never enter this store. */
export class MarkdownViewState {
  private wraps = new Map<string, boolean>();
  wrapped(key: string) { return this.wraps.get(key) ?? false; }
  setWrapped(key: string, value: boolean) { this.wraps.set(key, value); }
}
export function markdownScope(key: string) { return `markdown-${key.replace(/[^a-zA-Z0-9-]/g, character => `_${character.codePointAt(0)!.toString(16)}_`)}-`; }
