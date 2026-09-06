import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BROWSER_FRAME_PROTOCOL_VERSION,
  validBrowserFrameTarget,
  type BrowserControlReceipt,
  type BrowserFrameSnapshot,
  type BrowserFrameTarget,
  type BrowserHumanAction,
  type BrowserMetadataSnapshot,
  type DesktopBridge,
  type NativeBrowserTabMetadata,
} from "../../../../packages/shared/src/protocol";
import { Icon } from "./Icons";
import { browserAddressLabel, browserExternalAddress, browserNavigationAddress } from "./browser-address";
import { framePoint } from "./browser-input";
import "./browser-panel.css";

interface Props {
  bridge: DesktopBridge;
  hostId: string;
  sessionId: string;
  active: boolean;
  /** A dock page observes exactly one native target, even after host restart. */
  nativeTarget?: BrowserFrameTarget;
  onMetadata?(tab: NativeBrowserTabMetadata): void;
}
const same = (a: BrowserFrameTarget | undefined, b: BrowserFrameTarget) =>
  Boolean(
    a &&
    a.workerPid === b.workerPid &&
    a.name === b.name &&
    a.targetId === b.targetId,
  );
const storageKey = (hostId: string, sessionId: string) =>
  `browser.preview.selected.${hostId}.${sessionId}`;
function readSelection(key: string): BrowserFrameTarget | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return validBrowserFrameTarget(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
function saveSelection(key: string, target: BrowserFrameTarget) {
  try {
    localStorage.setItem(key, JSON.stringify(target));
  } catch {
    /* Selection remains usable in this window. */
  }
}
function receiptMatches(
  receipt: BrowserControlReceipt,
  requestId: string,
  hostId: string,
  sessionId: string,
  target: BrowserFrameTarget,
) {
  return (
    receipt.protocolVersion === 1 &&
    receipt.requestId === requestId &&
    receipt.hostId === hostId &&
    receipt.sessionId === sessionId &&
    same(receipt, target)
  );
}
function modifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) {
  return [
    event.altKey && "Alt",
    event.ctrlKey && "Control",
    event.metaKey && "Meta",
    event.shiftKey && "Shift",
  ].filter(Boolean) as Array<"Alt" | "Control" | "Meta" | "Shift">;
}

export function BrowserPanel(props: Props) {
  // Changing owners must synchronously discard pixels from the previous owner.
  return (
    <SessionBrowserPreview
      key={JSON.stringify([props.hostId, props.sessionId, props.nativeTarget?.workerPid, props.nativeTarget?.name, props.nativeTarget?.targetId])}
      {...props}
    />
  );
}

function SessionBrowserPreview({ bridge, hostId, sessionId, active, nativeTarget, onMetadata }: Props) {
  const selectionKey = storageKey(hostId, sessionId);
  const [metadata, setMetadata] = useState<BrowserMetadataSnapshot | null>();
  const [selected, setSelected] = useState(() => nativeTarget ?? readSelection(selectionKey));
  const metadataCallback = useRef(onMetadata); metadataCallback.current = onMetadata;
  const selectedRef = useRef(selected);
  const [frame, setFrame] = useState<BrowserFrameSnapshot>();
  const frameRef = useRef(frame);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [toolbarError, setToolbarError] = useState<string>();
  const viewport = useRef<HTMLDivElement>(null);
  const [heldInput, setHeldInput] = useState<BrowserHumanAction[]>([]);
  const [paused, setPaused] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [address, setAddress] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const addressFocusRef = useRef(false);
  const addressInput = useRef<HTMLInputElement>(null);
  const optionsMenu = useRef<HTMLDetailsElement>(null);
  const blankPageFocused = useRef(false);
  const [queuedText, setQueuedText] = useState(0);
  const selectionRevision = useRef(0);
  const inFlight = useRef(false);
  const pendingRef = useRef(false);
  const haltedRef = useRef(false);
  const nextRead = useRef(0);
  const mounted = useRef(true);
  const activeRef = useRef(active);
  const pausedRef = useRef(paused);
  const addressDirty = useRef(false);
  const contextRef = useRef(frame?.context);
  const textQueue = useRef<BrowserHumanAction[]>([]);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const skipInput = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  activeRef.current = active;
  pausedRef.current = paused;
  useEffect(() => {
    frameRef.current = frame;
    contextRef.current = frame?.context;
  }, [frame]);

  useLayoutEffect(() => { if (addressFocused) addressInput.current?.select(); }, [addressFocused]);

  const holdInput = (extra?: BrowserHumanAction) => {
    const waiting = [...(extra ? [extra] : []), ...textQueue.current];
    textQueue.current = []; setQueuedText(0);
    if (waiting.length) setHeldInput(previous => [...previous, ...waiting]);
  };
  useEffect(() => { if (!active || paused) holdInput(); }, [active, paused]);
  const chooseTarget = (target: BrowserFrameTarget) => {
    selectionRevision.current++;
    selectedRef.current = target;
    setSelected(target);
    setFrame(undefined);
    setError(undefined);
    holdInput();
    addressDirty.current = false;
    setAddress("");
    saveSelection(selectionKey, target);
  };

  useEffect(() => {
    if (
      !active ||
      paused ||
      !bridge.getBrowserMetadata ||
      !bridge.getBrowserFrame
    )
      return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      if (disposed) return;
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), delay);
    };
    async function poll() {
      if (disposed) return;
      if (document.visibilityState === "hidden" || pendingRef.current) {
        schedule(250);
        return;
      }
      if (inFlight.current) {
        schedule(100);
        return;
      }
      if (Date.now() < nextRead.current) {
        schedule(nextRead.current - Date.now());
        return;
      }
      inFlight.current = true;
      const revision = selectionRevision.current;
      const current = () =>
        !disposed &&
        revision === selectionRevision.current &&
        !pendingRef.current;
      try {
        const next = await bridge.getBrowserMetadata!(sessionId, hostId);
        if (!current()) return;
        if (
          next &&
          (next.hostId !== hostId ||
            next.sessionId !== sessionId ||
            next.protocolVersion !== 1)
        )
          throw new Error(
            "Browser tab metadata belongs to a different session.",
          );
        setMetadata(next);
        if (!next || next.availability !== "running") {
          setFrame(undefined);
          setError(undefined);
          return;
        }
        const previous = nativeTarget ?? selectedRef.current;
        const tab =
          next.tabs.find(
            (tab) =>
              tab.state === "alive" &&
              same(previous, {
                workerPid: next.workerPid,
                name: tab.name,
                targetId: tab.targetId,
              }),
          ) ?? (nativeTarget ? undefined : next.tabs.find(
            (tab) => tab.state === "alive" && tab.backend === "worker",
          ) ??
          next.tabs.find((tab) => tab.state === "alive"));
        if (!tab) {
          setFrame(undefined);
          setError(nativeTarget ? "This native browser tab is no longer available. Open an existing tab or create a new one." : undefined);
          return;
        }
        const target = {
          workerPid: next.workerPid,
          name: tab.name,
          targetId: tab.targetId,
        };
        metadataCallback.current?.(tab);
        if (!same(previous, target)) {
          selectedRef.current = target;
          setSelected(target);
          setFrame(undefined);
          saveSelection(selectionKey, target);
        }
        if (tab.backend !== "worker") {
          setFrame(undefined);
          setError(
            "This native browser backend does not support viewport previews yet.",
          );
          return;
        }
        const image = await bridge.getBrowserFrame!(sessionId, target, hostId);
        if (!current()) return;
        if (
          image.protocolVersion !== BROWSER_FRAME_PROTOCOL_VERSION ||
          image.hostId !== hostId ||
          image.sessionId !== sessionId ||
          !same(image, target) ||
          image.mimeType !== "image/jpeg"
        )
          throw new Error(
            "The browser viewport belongs to a different session or tab.",
          );
        setFrame(image);
        metadataCallback.current?.({ ...tab, url: image.url, title: image.title });
        if (!addressDirty.current && !addressFocusRef.current) setAddress(image.url);
        setError(undefined);
      } catch (cause) {
        if (current())
          setError(
            cause instanceof Error
              ? cause.message
              : "Browser preview is unavailable.",
          );
      } finally {
        inFlight.current = false;
        nextRead.current = Date.now() + 1000;
        schedule(1000);
      }
    }
    const visibility = () => {
      if (document.visibilityState === "visible") schedule(0);
    };
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [active, paused, bridge, hostId, sessionId, refresh, selectionKey]);

  const running = metadata?.availability === "running" ? metadata : undefined;
  const tabs = running?.tabs.filter((tab) => tab.state === "alive") ?? [];
  const choose = (tab: NativeBrowserTabMetadata) => {
    if (running)
      chooseTarget({
        workerPid: running.workerPid,
        name: tab.name,
        targetId: tab.targetId,
      });
  };
  const unsupported =
    !bridge.getBrowserMetadata || !bridge.getBrowserFrame
      ? "Update this desktop to preview native browser tabs."
      : metadata === null
        ? "Update this host to preview native browser tabs."
        : undefined;
  const reason =
    unsupported ??
    (metadata && metadata.availability !== "running"
      ? metadata.reason
      : undefined);
  const controlUnavailable = bridge.controlBrowser
    ? undefined
    : "Update this desktop to control native browser tabs.";
  const stale = Boolean(frame && (reason || error || paused || !active));
  const frameReady = Boolean(
    active &&
    !paused &&
    !error &&
    !actionError &&
    heldInput.length === 0 &&
    !reason &&
    bridge.controlBrowser &&
    frame?.context &&
    frame.controlEpoch &&
    selected &&
    same(frame, selected),
  );
  const controlsReady = frameReady && !pending;
  const blankPage = frame?.url === "about:blank";
  useEffect(() => {
    if (blankPage && controlsReady && !blankPageFocused.current) { blankPageFocused.current = true; addressInput.current?.focus(); }
  }, [blankPage, controlsReady]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (optionsMenu.current?.open && event.target instanceof Node && !optionsMenu.current.contains(event.target)) optionsMenu.current.open = false; };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);

  const control = async (
    action: BrowserHumanAction,
    queued = false,
  ): Promise<void> => {
    const image = frameRef.current;
    const target = selectedRef.current;
    if (
      !frameReady || haltedRef.current ||
      !activeRef.current || pausedRef.current ||
      (!queued && pendingRef.current) ||
      !bridge.controlBrowser ||
      !image?.controlEpoch ||
      !target ||
      !same(image, target)
    )
      return;
    const context = contextRef.current ?? image.context;
    if (!context) return;
    const requestId = crypto.randomUUID();
    // Invalidates a capture already in progress before this native mutation.
    const revision = ++selectionRevision.current;
    pendingRef.current = true;
    setPending(true);
    try {
      const receipt = await bridge.controlBrowser(
        sessionId,
        {
          requestId,
          controlEpoch: image.controlEpoch,
          capturedAt: image.capturedAt,
          target,
          context,
          action,
        },
        hostId,
      );
      if (
        !mounted.current ||
        revision !== selectionRevision.current
      )
        return;
      if (!receiptMatches(receipt, requestId, hostId, sessionId, target)) {
        haltedRef.current = true; holdInput(); setActionError(
          "The browser action receipt belongs to a different session or tab.",
        );
        return;
      }
      if (receipt.outcome === "unknown") {
        haltedRef.current = true; holdInput(); setActionError(
          receipt.message ||
            "The browser action outcome is unknown. It was not replayed.",
        );
        return;
      }
      if (receipt.outcome === "rejected") {
        haltedRef.current = true; holdInput(action); setActionError(receipt.message || "The browser action was rejected.");
        return;
      }
      contextRef.current = receipt.context ?? context;
      if (!activeRef.current || pausedRef.current) { holdInput(); return; }
      if (action.type === "navigate") addressDirty.current = false;
      const next = textQueue.current.shift();
      setQueuedText(
        textQueue.current.reduce(
          (count, item) =>
            count + (item.type === "text" ? item.text.length : 0),
          0,
        ),
      );
      if (next) {
        await control(next, true);
        return;
      }
      setError(undefined);
      setRefresh((value) => value + 1);
    } catch (cause) {
      if (mounted.current && revision === selectionRevision.current) {
        haltedRef.current = true; holdInput(); setActionError(
          cause instanceof Error
            ? cause.message
            : "The browser action could not be confirmed; inspect the page before acting again.",
        );
      }
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const queuedCharacters = () =>
    textQueue.current.reduce(
      (count, item) => count + (item.type === "text" ? item.text.length : 0),
      0,
    );
  const enqueue = (action: BrowserHumanAction) => {
    if (haltedRef.current) { holdInput(action); return; }
    if (!frameReady) return;
    if (!pendingRef.current) {
      void control(action);
      return;
    }
    if (
      textQueue.current.length >= 256 ||
      queuedCharacters() + (action.type === "text" ? action.text.length : 0) >
        16_384
    ) {
      haltedRef.current = true; holdInput(action); setActionError("Browser input reached its queue limit. Buffered input was retained without sending it.");
      return;
    }
    const previous = textQueue.current.at(-1);
    if (action.type === "text" && previous?.type === "text")
      previous.text += action.text;
    else textQueue.current.push(action);
    setQueuedText(queuedCharacters());
  };
  const submitAddress = (event: React.FormEvent) => {
    event.preventDefault();
    if (!controlsReady) return;
    try {
      const url = browserNavigationAddress(address);
      if (url) { setToolbarError(undefined); addressInput.current?.blur(); void control({ type: "navigate", url }); }
    } catch (cause) { setToolbarError(cause instanceof Error ? cause.message : 'The page address could not be opened.'); }
  };
  const pointer = (event: React.MouseEvent<HTMLImageElement>) => {
    if (!controlsReady || !frame?.context) return;
    const point = framePoint(
      event.currentTarget.getBoundingClientRect(),
      frame.context,
      event.clientX,
      event.clientY,
    );
    if (!point) return;
    textInput.current?.focus();
    void control({ type: "click", ...point });
  };
  const wheel = (event: React.WheelEvent<HTMLImageElement>) => {
    if (!controlsReady || !frame?.context) return;
    const point = framePoint(
      event.currentTarget.getBoundingClientRect(),
      frame.context,
      event.clientX,
      event.clientY,
    );
    if (!point) return;
    event.preventDefault();
    void control({
      type: "wheel",
      ...point,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
    });
  };
  const frameKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const supported = [
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ];
    if (
      !frameReady ||
      event.nativeEvent.isComposing ||
      !supported.includes(event.key)
    )
      return;
    event.preventDefault();
    const modifierKeys = modifiers(event);
    enqueue({
      type: "key",
      key: event.key,
      ...(modifierKeys.length ? { modifiers: modifierKeys } : {}),
    });
  };
  const captureInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    if (composing.current) return;
    if (skipInput.current) { skipInput.current = false; field.value = ""; return; }
    const value = field.value;
    field.value = "";
    enqueue({ type: "text", text: value });
  };
  const compositionEnd = (
    event: React.CompositionEvent<HTMLTextAreaElement>,
  ) => {
    composing.current = false;
    const value = event.currentTarget.value || event.data;
    event.currentTarget.value = "";
    if (!value) return;
    skipInput.current = true;
    setTimeout(() => { skipInput.current = false; }, 0);
    enqueue({ type: "text", text: value });
  };

  return (
    <section className="browser-panel" aria-label="Browser preview" onKeyDown={event => {
      if (event.key === "Escape" && optionsMenu.current?.open) { optionsMenu.current.open = false; optionsMenu.current.querySelector<HTMLElement>("summary")?.focus(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") { event.preventDefault(); addressInput.current?.focus(); addressInput.current?.select(); }
    }}>

      {!nativeTarget && <div
        className="browser-tabs"
        role="tablist"
        aria-label="Native browser tabs"
      >
        {tabs.map((tab) => (
          <button
            role="tab"
            aria-selected={Boolean(
              running &&
              same(selected, {
                workerPid: running.workerPid,
                name: tab.name,
                targetId: tab.targetId,
              }),
            )}
            key={`${tab.name}:${tab.targetId}`}
            disabled={pending}
            onClick={() => choose(tab)}
            title={tab.url}
          >
            {tab.title || tab.url || tab.name}
            {tab.backend !== "worker" ? " · unavailable" : ""}
          </button>
        ))}
      </div>}
      <div className="browser-controls" aria-label="Browser controls">
        <button
          aria-label="Back"
          title="Back"
          disabled={!controlsReady || !frame?.context?.navigation?.canGoBack}
          onClick={() => void control({ type: "back" })}
        >
          <Icon name="browserBack" />
        </button>
        <button
          aria-label="Forward"
          title="Forward"
          disabled={!controlsReady || !frame?.context?.navigation?.canGoForward}
          onClick={() => void control({ type: "forward" })}
        >
          <Icon name="browserBack" className="browser-forward-icon" />
        </button>
        <button
          aria-label="Reload page"
          title="Reload page"
          disabled={!controlsReady}
          onClick={() => void control({ type: "reload" })}
        >
          <Icon name="browserReload" />
        </button>
        <form onSubmit={submitAddress}>
          <input
            ref={addressInput}
            aria-label="Page address"
            role="combobox"
            aria-expanded={false}
            aria-autocomplete="none"
            spellCheck={false}
            autoComplete="off"
            disabled={!selected || !active}
            value={addressFocused || addressDirty.current ? (address === "about:blank" ? "" : address) : browserAddressLabel(address)}
            onFocus={event => { addressFocusRef.current = true; setAddressFocused(true); }}
            onBlur={() => { addressFocusRef.current = false; setAddressFocused(false); if (!addressDirty.current) setAddress(frameRef.current?.url ?? address); }}
            onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); addressDirty.current = false; setAddress(frameRef.current?.url ?? ""); event.currentTarget.blur(); } }}
            onChange={(event) => {
              addressDirty.current = true;
              setAddress(event.target.value);
            }}
            placeholder="Search or enter a URL"
          />
          <button
            aria-label="Open in external browser"
            title="Open in this device’s external browser"
            disabled={!frame || !browserExternalAddress(frame.url) || !bridge.openExternal}
            type="button"
            onClick={() => { setToolbarError(undefined); if (frame && bridge.openExternal) void bridge.openExternal(frame.url).catch(cause => setToolbarError(cause instanceof Error ? cause.message : "The external browser could not be opened.")); }}
          ><Icon name="browserExternal"/></button>
        </form>
        <details ref={optionsMenu} className="browser-options" name="browser-options" onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false;
        }}>
          <summary aria-label="Browser options" title="Browser options" onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (optionsMenu.current) { optionsMenu.current.open = true; const buttons = optionsMenu.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'); (event.key === 'ArrowDown' ? buttons[0] : buttons[buttons.length - 1])?.focus(); }
            }
          }}><Icon name="browserOptions"/></summary>
          <div className="browser-options-menu" role="menu" aria-label="Browser options" onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }}>
            <p>Native browser preview</p>
            <button role="menuitem" disabled={!controlsReady || !frame?.context?.navigation} onClick={() => {
              const rect = viewport.current?.getBoundingClientRect();
              if (!rect || rect.width < 1 || rect.height < 1) return;
              if (optionsMenu.current) optionsMenu.current.open = false;
              void control({ type: 'resize', width: Math.min(16384, Math.floor(rect.width)), height: Math.min(16384, Math.floor(rect.height)) });
            }}>Resize page to panel</button>
            <button role="menuitem" aria-label="Refresh browser preview" disabled={Boolean(unsupported) || !active || paused || pending}
              onClick={() => { if (optionsMenu.current) optionsMenu.current.open = false; haltedRef.current = heldInput.length > 0; setActionError(undefined); setRefresh(value => value + 1); }}>Refresh preview</button>
            <button role="menuitemcheckbox" aria-checked={paused} disabled={Boolean(unsupported) || pending}
              onClick={() => { if (optionsMenu.current) optionsMenu.current.open = false; setPaused(value => { if (!value) holdInput(); return !value; }); }}>{paused ? "Resume" : "Pause"}</button>
          </div>
        </details>
      </div>
      {Boolean(reason || actionError || error || toolbarError || paused || pending || queuedText) && (
        <p className="browser-status" role="status">
          {reason ?? actionError ?? toolbarError ??
            (error
              ? `${error}${queuedText ? ` ${queuedText} character${queuedText === 1 ? "" : "s"} remain unsent.` : ""}`
              : pending
                ? "Browser action in progress…"
                : queuedText
                  ? `${queuedText} character${queuedText === 1 ? "" : "s"} waiting to send.`
                  : "Preview paused.")}
        </p>
      )}
      {heldInput.length > 0 && <details className="browser-input-recovery" open>
        <summary>Unsent browser input retained</summary>
        <textarea aria-label="Unsent browser input" readOnly value={heldInput.map(action => action.type === "text" ? action.text : action.type === "key" ? `[${action.key}]` : `[${action.type}]`).join("")}/>
        <button onClick={() => { haltedRef.current = false; setHeldInput([]); setActionError(undefined); setRefresh(value => value + 1); }}>Discard unsent input</button>
      </details>}
      {frame ? (
        <figure>
          {blankPage && <div className="browser-blank-page"><Icon name="globe"/><strong>Start browsing</strong><span>Enter a URL to open a page</span></div>}
          <div
            ref={viewport}
            className={`browser-viewport${controlsReady ? " browser-viewport-live" : ""}${blankPage ? " browser-blank-viewport" : ""}`}
          >
            <img
              src={`data:${frame.mimeType};base64,${frame.data}`}
              width={frame.width}
              height={frame.height}
              alt={frame.title || "Native browser viewport"}
              onClick={pointer}
              onWheel={wheel}
              onError={() => {
                setFrame(undefined);
                setError("The browser viewport image could not be displayed.");
              }}
            />
            <textarea
              ref={textInput}
              maxLength={16384}
              className="browser-input-capture"
              aria-label="Browser page keyboard input"
              disabled={!frameReady}
              onKeyDown={frameKey}
              onInput={captureInput}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={compositionEnd}
            />
          </div>
          <figcaption className={stale ? "browser-stale" : "browser-preview-caption"}>
            Viewport preview · {frame.title || frame.url}
            {stale ? " · stale preview" : ""}
          </figcaption>
        </figure>
      ) : (
        <div className="browser-empty">
          {reason || error
            ? "No current preview."
            : metadata === undefined
              ? "Loading native browser tabs…"
              : "Tabs opened by this session’s browser tool appear here."}
        </div>
      )}
    </section>
  );
}
