import "./native-switch.css";

/** Controlled native-setting switch. The owner commits state after its write. */
export function NativeSwitch({ checked, disabled, label, title, className = "", onChange }: {
  checked: boolean; disabled?: boolean; label: string; title?: string; className?: string;
  onChange(checked: boolean): void;
}) {
  return <button type="button" role="switch" className={`native-enabled-switch ${className}`} aria-label={label} aria-checked={checked} disabled={disabled} title={title} onClick={() => onChange(!checked)}><span/></button>;
}
