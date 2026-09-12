import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DesktopBridge, InteractionAction, OmpInteraction, OmpInteractionResponse } from "../../../../packages/shared/src/protocol";
import { InteractionsState } from "./interactions-state";
import { Icon } from "./Icons";

type ApprovalCommands = { "approval-approve": () => void; "approval-decline": () => void };
const confirmationCommands = new WeakMap<HTMLFormElement, { hostId: string; sessionId: string; actions: ApprovalCommands }>();

export function approvalCommands(root: HTMLElement, hostId: string, sessionId: string, origin: Element | null): ApprovalCommands | undefined {
  const form = origin?.closest<HTMLFormElement>("form.interaction-card");
  if (!form || !root.contains(form) || !form.isConnected || form.closest("[hidden], [inert]")) return;
  const owner = confirmationCommands.get(form);
  return owner?.hostId === hostId && owner.sessionId === sessionId ? owner.actions : undefined;
}

export function PendingInteractions({ bridge, hostId, sessionId, localHostId, connected }: { bridge: DesktopBridge; hostId: string; sessionId: string; localHostId?: string; connected: boolean }) {
  const data = useMemo(() => new InteractionsState(bridge, hostId, sessionId, localHostId), [bridge, hostId, sessionId, localHostId]);
  const [, redraw] = useReducer(value => value + 1, 0);
  useEffect(() => { const unsubscribe = data.subscribe(redraw); data.start(); return () => { unsubscribe(); data.stop(); }; }, [data]);
  useEffect(() => { if (connected) void data.refresh(); }, [data, connected]);
  const pending = data.requests.length > 0;
  useEffect(() => {
    if (!connected || !pending) return;
    const interval = setInterval(() => { void data.refresh(); }, 2_000);
    return () => clearInterval(interval);
  }, [data, pending, connected]);
  if (!pending && !data.loadError && !data.responseError) return null;
  return <section className="pending-interactions" aria-label="Pending agent requests">
    {data.loadError && <div className="inline-error" role="alert"><span>Pending requests could not be refreshed: {data.loadError}</span><button disabled={!connected} onClick={() => void data.refresh()}>Retry</button></div>}
    {data.responseError && <div className="inline-error" role="alert"><span>{data.responseError}</span><button className="icon-button small" onClick={() => data.dismissResponseError()} aria-label="Dismiss response error"><Icon name="close"/></button></div>}
    {!connected && pending && <p className="subtle-notice">This host is disconnected. These are the last received requests; reconnect before answering.</p>}
    {data.requests.map(request => <InteractionCard key={`${hostId}:${sessionId}:${request.id}`} hostId={hostId} request={request} disabled={!connected || data.responding.has(request.id)} sending={data.responding.has(request.id)} respond={response => data.respond(request.id, response)}/>)}
  </section>;
}

function InteractionCard({ hostId, request, disabled, sending, respond }: { hostId: string; request: OmpInteraction; disabled: boolean; sending: boolean; respond(response: OmpInteractionResponse): Promise<void> }) {
  const [value, setValue] = useState(request.prefill ?? "");
  const [index, setIndex] = useState(Math.min(Math.max(request.initialIndex ?? 0, 0), Math.max(0, (request.options?.length ?? 1) - 1)));
  const [now, setNow] = useState(Date.now());
  const form = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const element = form.current;
    if (!element || disabled || request.method !== "confirm") return;
    const answer = (value: boolean) => {
      if (!element.isConnected || element.closest("[hidden], [inert]") || confirmationCommands.get(element)?.actions !== actions) return;
      void respond({ value });
    };
    const actions = { "approval-approve": () => answer(true), "approval-decline": () => answer(false) };
    confirmationCommands.set(element, { hostId, sessionId: request.sessionId, actions });
    return () => { confirmationCommands.delete(element); };
  }, [hostId, request, disabled, respond]);
  useEffect(() => {
    if (request.expiresAt === undefined) return;
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [request.expiresAt]);
  const titleId = `request-${request.id}`;
  function submit(event: React.FormEvent) {
    event.preventDefault(); if (disabled || request.method === "confirm") return;
    if (request.method === "select") { const option = request.options?.[index]; if (option) void respond({ value: option.label }); }
    else void respond({ value });
  }
  const labels: Record<InteractionAction, string> = { left: "Previous", right: "Next", externalEditor: "Use external editor", timeoutReset: "Reset timer" };
  return <form ref={form} className={`interaction-card ${request.outline === false ? "without-outline" : ""}`} onSubmit={submit} aria-labelledby={titleId}>
    <div className="interaction-heading"><strong id={titleId}>{request.title}</strong>{sending && <span className="spinner" aria-label="Sending response"/>}</div>
    {request.message && <p className="interaction-message">{request.message}</p>}
    {request.method === "select" && <div className="interaction-options" role="listbox" aria-label={request.title}>{request.options?.map((option, optionIndex) => {
      const markable = request.markableCount === undefined || optionIndex < request.markableCount;
      const checked = request.checkedIndices?.includes(optionIndex) ?? false;
      return <button type="button" className={`interaction-option ${index === optionIndex ? "selected" : ""}`} role="option" aria-selected={index === optionIndex} disabled={disabled} key={`${optionIndex}:${option.label}`} onClick={() => setIndex(optionIndex)} onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); if (!disabled) void respond({ value: option.label }); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const next = Math.min(Math.max(optionIndex + (event.key === "ArrowDown" ? 1 : -1), 0), request.options!.length - 1); setIndex(next); (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus(); }
        const action = event.key === "ArrowLeft" ? "left" : event.key === "ArrowRight" ? "right" : undefined;
        if (action && request.actions.includes(action)) { event.preventDefault(); if (!disabled) void respond({ action }); }
      }}>
        <span className={`option-marker ${request.selectionMarker === "checkbox" ? markable ? "checkbox" : "unmarked" : "radio"} ${request.selectionMarker === "checkbox" ? checked ? "checked" : "" : index === optionIndex ? "checked" : ""}`} aria-hidden="true">{request.selectionMarker === "checkbox" && checked ? "✓" : ""}</span><span><span className="option-label">{option.label}</span>{option.description && <span className="option-description">{option.description}</span>}</span>{request.selectionMarker === "checkbox" && markable && <span className="sr-only">{checked ? "Marked by host" : "Not marked by host"}</span>}
      </button>;
    })}{!request.options?.length && <p className="subtle-notice">The host supplied no options.</p>}</div>}
    {request.method === "input" && <input className="text-field" aria-label={request.title} value={value} onChange={event => setValue(event.target.value)} placeholder={request.placeholder} autoComplete="off" disabled={disabled}/>}
    {request.method === "editor" && <textarea className={`interaction-editor ${request.promptStyle ? "prompt-style" : ""}`} aria-label={request.title} value={value} onChange={event => setValue(event.target.value)} placeholder={request.placeholder} disabled={disabled} spellCheck={Boolean(request.promptStyle)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/>}
    {request.helpText && <p className="interaction-help">{request.helpText}</p>}
    {request.expiresAt !== undefined && <p className="interaction-expiry" title={`Host expiry: ${new Date(request.expiresAt).toLocaleString()}`}>{request.expiresAt > now ? `Host timeout in about ${Math.ceil((request.expiresAt - now) / 1_000)} seconds` : "Checking the host’s timeout status…"}</p>}
    <div className="interaction-actions"><div>{request.actions.map(action => <button className="secondary-button" type="button" key={action} disabled={disabled} onClick={() => void respond({ action })}>{labels[action]}</button>)}</div><div><button className="secondary-button" type="button" disabled={disabled} onClick={() => void respond({ cancel: true })}>Cancel</button>{request.method === "confirm" ? <><button className="secondary-button" type="button" disabled={disabled} onClick={() => void respond({ value: false })}>No</button><button className="primary-button" type="button" disabled={disabled} onClick={() => void respond({ value: true })}>Yes</button></> : <button className="primary-button" type="submit" disabled={disabled || request.method === "select" && !request.options?.[index]}>{request.method === "select" ? "Choose" : "Submit"}</button>}</div></div>
  </form>;
}
