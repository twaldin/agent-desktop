import { useEffect, useId, useRef, useState } from "react";
import type { GoalComposerDraft } from "../../../../packages/shared/src/goal-composer";
import { goalBudgetIssue } from "./goal-composer";
import { GoalIcon } from "./GoalIcons";
import { Icon } from "./Icons";
import "./goal-composer.css";

export interface GoalComposerIntentProps {
  intent: GoalComposerDraft; disabled: boolean;
  onChange(intent: GoalComposerDraft): void;
  /** Removes only the intent. Objective text, attachments, model and environment stay in the draft. */
  onClear(): void;
}

/** Pinned composer footer indicator: "Goal" label, "Clear goal" name, icon swaps to
 * a close mark on hover. The raw budget text is the draft's, so invalid input survives
 * persistence and is refused at send time, never silently corrected. */
export function GoalComposerIntent({ intent, disabled, onChange, onClear }: GoalComposerIntentProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null);
  const budget = intent.tokenBudget.trim(), issue = goalBudgetIssue(intent.tokenBudget);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (open) input.current?.focus({ preventScroll: true }); }, [open]);
  return <div className="goal-composer" role="group" aria-label="Goal intent" onKeyDown={event => { if (open && event.key === "Escape") { event.stopPropagation(); event.preventDefault(); close(); } }}>
    <button type="button" className="composer-selection-trigger goal-composer-chip" aria-label="Clear goal" title="Clear goal" disabled={disabled} onClick={onClear}>
      <GoalIcon name="goal" className="goal-composer-mark"/><Icon name="close" className="goal-composer-clear"/><span>Goal</span>
    </button>
    <button type="button" ref={trigger} className={`composer-selection-trigger goal-composer-budget-trigger${issue ? " goal-composer-invalid" : ""}`} aria-expanded={open} aria-controls={id} disabled={disabled}
      title={issue ?? "Goal token budget"} onClick={() => { if (open) close(); else setOpen(true); }}>
      <span>{issue ? "Budget · invalid" : budget ? `Budget · ${Number(budget).toLocaleString()}` : "Budget · unlimited"}</span>
    </button>
    {open && <div id={id} className="goal-composer-budget">
      <label>Budget<input ref={input} type="text" inputMode="numeric" aria-label="Goal token budget" aria-invalid={Boolean(issue)} aria-describedby={issue ? `${id}-issue` : undefined}
        placeholder="Unlimited" value={intent.tokenBudget} disabled={disabled} onChange={event => onChange({ tokenBudget: event.target.value.slice(0, 128) })}
        onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" || event.key === "Enter") { event.preventDefault(); close(); } }}/></label>
      {issue ? <span id={`${id}-issue`} role="alert">{issue}</span> : <span>Positive whole number of tokens, or empty for no budget.</span>}
    </div>}
  </div>;
}
