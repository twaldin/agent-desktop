import type { ReactNode } from "react";
import { Icon } from "./Icons";

/** Keep the full native option labels while using a concise closed value. */
export function CompactSelect({ label, displayValue, value, disabled, onChange, children }: {
  label: string; displayValue: string; value: string; disabled?: boolean;
  onChange(value: string): void; children: ReactNode;
}) {
  return <span className="compact-select">
    <span className="compact-select-value" aria-hidden="true">{displayValue}</span><Icon name="chevron"/>
    <select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{children}</select>
  </span>;
}
