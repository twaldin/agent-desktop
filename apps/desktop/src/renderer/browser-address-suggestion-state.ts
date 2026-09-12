import { parseBrowserAddress } from "./browser-address";

export interface AddressSuggestionIdentity { id: string; canBeDefault: boolean }
export interface AddressKeyboardSelection { query: string; ids: readonly string[]; selectedId: string }

/** Keyboard navigation pins order and membership until the next edit. A removed
 * selection remains missing, so Enter cannot silently submit a different row/URL. */
export function addressSuggestionSelection<T extends AddressSuggestionIdentity>(
  query: string, current: readonly T[], keyboard?: AddressKeyboardSelection,
) {
  const frozen = keyboard?.query === query ? keyboard : undefined;
  const byId = new Map(current.map(row => [row.id, row]));
  const rows = frozen ? frozen.ids.flatMap(id => byId.get(id) ?? []) : [...current];
  let allowDefault = false;
  try { allowDefault = parseBrowserAddress(query).kind === "search"; } catch { /* Navigation owns the local-file error. */ }
  const selectedId = frozen?.selectedId ?? (allowDefault ? rows.find(row => row.canBeDefault)?.id : undefined);
  const selectedIndex = rows.findIndex(row => row.id === selectedId);
  return { rows, selectedIndex, selected: rows[selectedIndex], missing: Boolean(frozen && selectedIndex < 0) };
}
export function moveAddressSuggestion<T extends AddressSuggestionIdentity>(
  query: string, current: readonly T[], direction: 1 | -1, keyboard?: AddressKeyboardSelection,
): AddressKeyboardSelection | undefined {
  const view = addressSuggestionSelection(query, current, keyboard);
  if (!view.rows.length) return keyboard;
  const next = view.selectedIndex < 0 ? direction > 0 ? 0 : view.rows.length - 1
    : (view.selectedIndex + direction + view.rows.length) % view.rows.length;
  return { query, ids: keyboard?.query === query ? keyboard.ids : view.rows.map(row => row.id), selectedId: view.rows[next]!.id };
}

/** Fixed body portal: below the address bar, no gap, at least 360px where the
 * viewport permits it. Narrow/offscreen anchors never create horizontal overflow. */
export function addressSuggestionPosition(anchor: { left: number; right: number; top: number; bottom: number; width: number }, viewport: { width: number; height: number }) {
  if (![anchor.left, anchor.right, anchor.top, anchor.bottom, anchor.width, viewport.width, viewport.height].every(Number.isFinite)
    || anchor.width <= 0 || anchor.bottom <= 0 || anchor.top >= viewport.height || anchor.right <= 0 || anchor.left >= viewport.width) return undefined;
  const margin = 4;
  const width = Math.min(Math.max(360, anchor.width), Math.max(0, viewport.width - margin * 2));
  const top = Math.max(margin, anchor.bottom);
  const maxHeight = Math.max(0, viewport.height - top - margin);
  if (width <= 0 || maxHeight <= 0) return undefined;
  return { left: Math.max(margin, Math.min(anchor.left, viewport.width - width - margin)), top, width, maxHeight };
}
