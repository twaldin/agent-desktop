export interface ModelPickerOption {
  value: string;
  label: string;
  provider?: string;
  detail?: string;
  disabled?: boolean;
}

/** Search identity as well as display name; duplicate names across providers stay distinct. */
export function filterModelOptions(options: readonly ModelPickerOption[], query: string): ModelPickerOption[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return options.filter(option => {
    const text = `${option.provider ?? ""} ${option.label} ${option.value} ${option.detail ?? ""}`.toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

export function nextModelOption(options: readonly ModelPickerOption[], current: number, direction: 1 | -1): number {
  for (let index = current + direction; index >= 0 && index < options.length; index += direction) if (!options[index]!.disabled) return index;
  return current >= 0 && current < options.length && !options[current]!.disabled ? current : -1;
}
