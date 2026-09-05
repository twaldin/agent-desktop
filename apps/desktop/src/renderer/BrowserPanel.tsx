import { useEffect, useRef, useState } from "react";
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
import { framePoint } from "./browser-input";
import "./browser-panel.css";

interface Props {
  bridge: DesktopBridge;
  hostId: string;
  sessionId: string;
  active: boolean;
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
      key={JSON.stringify([props.hostId, props.sessionId])}
      {...props}
    />
  );
}

function SessionBrowserPreview({ bridge, hostId, sessionId, active }: Props) {
  const selectionKey = storageKey(hostId, sessionId);
  const [metadata, setMetadata] = useState<BrowserMetadataSnapshot | null>();
  const [selected, setSelected] = useState(() => readSelection(selectionKey));
  const selectedRef = useRef(selected);
  const [frame, setFrame] = useState<BrowserFrameSnapshot>();
  const frameRef = useRef(frame);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [heldInput, setHeldInput] = useState<BrowserHumanAction[]>([]);
  const [paused, setPaused] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [address, setAddress] = useState("");
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
        const previous = selectedRef.current;
        const tab =
          next.tabs.find(
            (tab) =>
              tab.state === "alive" &&
              same(previous, {
                workerPid: next.workerPid,
                name: tab.name,
                targetId: tab.targetId,
              }),
          ) ??
          next.tabs.find(
            (tab) => tab.state === "alive" && tab.backend === "worker",
          ) ??
          next.tabs.find((tab) => tab.state === "alive");
        if (!tab) {
          setFrame(undefined);
          setError(undefined);
          return;
        }
        const target = {
          workerPid: next.workerPid,
          name: tab.name,
          targetId: tab.targetId,
        };
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
        if (!addressDirty.current) setAddress(image.url);
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
    const url = address.trim();
    if (url) void control({ type: "navigate", url });
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
    <section className="browser-panel" aria-label="Browser preview">

      <div
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
      </div>
      <div className="browser-controls" aria-label="Browser controls">
        <button
          aria-label="Back"
          disabled={!controlsReady}
          onClick={() => void control({ type: "back" })}
        >
          <Icon name="chevron" className="browser-back-icon" />
        </button>
        <button
          aria-label="Forward"
          disabled={!controlsReady}
          onClick={() => void control({ type: "forward" })}
        >
          <Icon name="chevron" />
        </button>
        <button
          aria-label="Reload page"
          disabled={!controlsReady}
          onClick={() => void control({ type: "reload" })}
        >
          <Icon name="refresh" />
        </button>
        <form onSubmit={submitAddress}>
          <input
            aria-label="Page address"
            disabled={!controlsReady}
            value={address}
            onChange={(event) => {
              addressDirty.current = true;
              setAddress(event.target.value);
            }}
            placeholder="https://…"
          />
          <button
            aria-label="Open address"
            disabled={!controlsReady}
            type="submit"
          >
            <Icon name="arrow" />
          </button>
        </form>
        <div className="browser-preview-actions">
          <button
            aria-label="Refresh browser preview"
            disabled={Boolean(unsupported) || !active || paused || pending}
            onClick={() => { haltedRef.current = heldInput.length > 0; setActionError(undefined); setRefresh((value) => value + 1); }}
          >
            <Icon name="refresh" />
          </button>
          <button
            disabled={Boolean(unsupported) || pending}
            onClick={() =>
              setPaused((value) => {
                if (!value) {
                  holdInput();
                }
                return !value;
              })
            }
          >
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>
      {Boolean(reason || actionError || error || paused || pending || queuedText) && (
        <p className="browser-status" role="status">
          {reason ?? actionError ??
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
          <div
            className={`browser-viewport${controlsReady ? " browser-viewport-live" : ""}`}
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
          <figcaption>
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
