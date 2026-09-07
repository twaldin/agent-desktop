import { useState } from "react";
import type { TranscriptFileReference, TranscriptMessage } from "@agent-desktop/shared";
import type { TranscriptImages } from "./Transcript";
import { TranscriptFileReference as FileReference } from "./TranscriptFileReference";
import { ImagePreview } from "./ImagePreview";
import { Icon } from "./Icons";

/** OMP's separate auto-read record has no persisted user-message association.
 * Keep its own native identity and expose exactly what was recorded. */
export function TranscriptFileMentions({ message, images, connected }: { message: TranscriptMessage; images?: TranscriptImages; connected: boolean }) {
  return <section className="transcript-file-mentions" data-message-id={message.id} data-native-id={message.nativeId} aria-label="Referenced files">
    {message.fileReferences?.map((file, index) => <FileSnapshot key={`${index}:${file.path}`} file={file} nativeId={message.nativeId} images={images} connected={connected}/>)}
  </section>;
}
function FileSnapshot({ file, nativeId, images, connected }: { file: TranscriptFileReference; nativeId?: string; images?: TranscriptImages; connected: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const name = file.path.split("/").filter(Boolean).at(-1) || file.path;
  return <div className="transcript-file-snapshot">
    <div className="transcript-file-snapshot-heading"><button type="button" className="transcript-file-snapshot-toggle" aria-label={`Recorded context for ${name}`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Icon name="chevron" className={expanded ? "rotated" : ""}/></button>
      <FileReference path={file.path}/>
      {file.skippedReason && <span className="transcript-file-read-status">{file.skippedReason === "tooLarge" ? "Too large to auto-read" : "Binary · not auto-read"}{file.byteSize === undefined ? "" : ` · ${file.byteSize.toLocaleString()} bytes`}</span>}
    </div>
    {expanded && <div className="transcript-file-snapshot-body">
      {file.content ? <pre className="transcript-output-text">{file.content}</pre> : !file.image && <span className="transcript-empty-output">Empty file snapshot</span>}
      {file.image && (file.image.error ? <p className="transcript-message-notice">{file.image.error}</p> : nativeId && images
        ? <ImagePreview media={images.media} source={{ kind: "transcript", sessionId: images.sessionId, nativeEntryId: nativeId, blockIndex: file.image.blockIndex, mimeType: file.image.mimeType, bytes: file.image.bytes, sha256: file.image.sha256 }} hostId={images.hostId} connected={connected} label={name} className="transcript-image"/>
        : <p className="transcript-message-notice">Recorded image preview is unavailable in this view.</p>)}
    </div>}
  </div>;
}
