import { useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import type { WorkspaceQueryResult } from "@agent-desktop/shared";
import type { WorkspaceState } from "./workspace-state";
import { FileTypeIcon } from "./FileTypeIcon";
import { fileSearchDisplayText, fileSearchLabelParts } from "./workspace-file-search-label";
import "./workspace-file-search.css";

type SearchResult = Extract<WorkspaceQueryResult, { type: "files.search" }>;

/** Search belongs to the selected workspace host. Selecting a result still uses
 * the normal owner-checked file read and preview-tab path. */
export function WorkspaceFileSearch({ data, connected, onClose, onOpenFile }: {
  data: Pick<WorkspaceState, "query">;
  connected: boolean;
  onClose(): void;
  onOpenFile(path: string): void;
}) {
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false), dispatched = useRef(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(""), [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ owner: typeof data; query: string; value: SearchResult }>();
  const [failure, setFailure] = useState<{ owner: typeof data; query: string; message: string }>();
  const term = query.trim();
  useEffect(() => {
    let current = true;
    setResult(undefined); setFailure(undefined); setSelected("");
    if (!term || !connected) return;
    // The transport has no cancellation contract. Native work is bounded at
    // the host; cleanup fences replies after a new query/owner or dismissal.
    const timer = setTimeout(() => {
      void data.query({ type: "files.search", query: term, limit: 50 }).then(value => {
        if (value.type !== "files.search") throw new Error("The host returned the wrong file search response.");
        if (current) setResult({ owner: data, query: term, value });
      }).catch(cause => {
        if (current) setFailure({ owner: data, query: term, message: cause instanceof Error ? cause.message : "File search failed." });
      });
    }, 150);
    return () => { current = false; clearTimeout(timer); };
  }, [data, term, connected, retry]);
  const visible = connected && result?.owner === data && result.query === term ? result.value : undefined;
  const error = connected && failure?.owner === data && failure.query === term ? failure.message : undefined;
  const entries = visible?.entries ?? [];
  const select = (path: string) => {
    if (!connected || dispatched.current || !entries.some(entry => entry.path === path)) return;
    dispatched.current = true;
    onClose(); onOpenFile(path);
  };
  return <Dialog.Root open onOpenChange={open => { if (!open && !composing.current) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="workspace-file-search-overlay"/>
      <Dialog.Content onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus({ preventScroll: true }); }} className="workspace-file-search" onEscapeKeyDown={event => { if (composing.current) event.preventDefault(); }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (!dispatched.current && returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
        }}>
        <Dialog.Title className="sr-only">Command menu</Dialog.Title>
        <Dialog.Description className="sr-only">Search commands and past chats.</Dialog.Description>
        <Command label="Command menu" shouldFilter={false} value={selected} onValueChange={setSelected}
          onKeyDownCapture={event => {
            // Some IME key events omit isComposing. Keep the lifecycle guard
            // across result/owner redraws before cmdk handles Enter/navigation.
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation();
          }}>
          <Command.Input ref={input} className="workspace-file-search-input" placeholder="Search files" value={query} maxLength={512}
            onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
            onValueChange={value => { setQuery(value); setSelected(""); }}/>
          <Command.List className="workspace-file-search-results" label="Suggestions" aria-busy={Boolean(connected && term && !visible && !error)}>
            <Command.Group heading="Files">
              {!connected ? <p role="status">Reconnect to search files on this host.</p>
                : !term ? <p>Type to search for files</p>
                : error ? <div className="workspace-file-search-error"><p role="alert">{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>
                : !visible ? <p role="status">Searching files…</p>
                : entries.length === 0 ? <p role="status">No files found</p>
                : entries.map(entry => {
                    const parts = fileSearchLabelParts(entry.name, term), matched = parts.some(part => part.isMatch);
                    const directory = entry.path.includes("/") ? fileSearchDisplayText(entry.path.slice(0, entry.path.lastIndexOf("/"))) : "";
                    return <Command.Item key={entry.path} value={entry.path} className="workspace-file-search-result" onSelect={select}>
                      <FileTypeIcon path={entry.path}/><span className="workspace-file-search-content">
                        <span className={`workspace-file-search-name${directory ? " with-directory" : ""}`}>{parts.map((part, index) => <span key={index} className={!part.isMatch && matched ? "workspace-file-search-unmatched" : undefined}>{part.text}</span>)}</span>
                        {directory && <span className="workspace-file-search-directory">{directory}</span>}
                      </span>
                    </Command.Item>;
                  })}
              {visible?.status === "truncated" && <p role="status">More matches available. Refine your search.</p>}
            </Command.Group>
          </Command.List>
        </Command>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
