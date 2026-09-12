import "./workspace-file-name.css";

/** Pinned tree labels preserve the filename's end, with a lower-priority stem. */
export function WorkspaceFileName({ name }: { name: string }) {
  if (name.length < 5) return <span className="workspace-file-name"><FileNameSegment text={name} mode="start"/></span>;
  const dot = name.lastIndexOf("."), extension = dot + 1;
  const split = extension > 0 && name.length - extension <= 10
    ? extension
    : Math.ceil(name.length / 2);
  return <span className="workspace-file-name" data-file-name-middle>
    <span data-file-name-priority="2"><FileNameSegment text={name.slice(0, split)} mode="end"/></span>
    <span data-file-name-priority="1"><FileNameSegment text={name.slice(split)} mode="start"/></span>
  </span>;
}

function FileNameSegment({ text, mode }: { text: string; mode: "start" | "end" }) {
  const content = <span>
    <span data-file-name-content="visible">{mode === "start" ? <span>{text}</span> : text}</span>
    <span data-file-name-content="overflow" aria-hidden="true">{mode === "start" ? <span>{text}</span> : text}</span>
  </span>;
  const marker = <span data-file-name-measure aria-hidden="true"><span data-file-name-marker>…</span></span>;
  return <span data-file-name-truncate={mode}><span data-file-name-grid>
    {mode === "end" ? <>{content}{marker}</> : <>{marker}{content}<span/></>}
  </span></span>;
}
