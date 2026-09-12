import { useEffect, useState, useRef } from 'react';
import { sessionOutputKey, type SessionOutput } from '@agent-desktop/shared';
import { FileTypeIcon } from './FileTypeIcon';
import { Icon } from './Icons';
import { loadAttachmentMedia, type AttachmentMediaContext } from './attachment-media';
import type { SuggestedOutputs } from './suggested-outputs';
export interface SuggestedOutputRowsProps {
  owner: SuggestedOutputs;
  images: { hostId: string; sessionId: string; media: AttachmentMediaContext };
  onOpen(output: SessionOutput, current: () => boolean): void | Promise<void>;
  onSource?(output: Extract<SessionOutput, { kind: 'html-preview' }>, current: () => boolean): void;
}
function GeneratedThumbnail({ output, images }: Pick<SuggestedOutputRowsProps, 'images'> & { output: Extract<SessionOutput, { kind: 'generated-image' }> }) {
  const { hostId, sessionId, media } = images;
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true, allocated: string | undefined;
    void loadAttachmentMedia(media, { kind: 'transcript', source: 'generated', sessionId, nativeEntryId: output.entryId, blockIndex: output.imageIndex,
      sha256: output.sha256, bytes: output.bytes, mimeType: output.mimeType }, hostId, true).then(image => {
      if (active) { allocated = URL.createObjectURL(image.blob); setUrl(allocated); }
    }).catch(() => {});
    return () => { active = false; if (allocated) URL.revokeObjectURL(allocated); };
  }, [media, hostId, sessionId, output.entryId, output.imageIndex, output.sha256]);
  return url ? <img src={url} alt=""/> : <FileTypeIcon path={output.path}/>;
}
export function SuggestedOutputRows({ owner, images, onOpen, onSource }: SuggestedOutputRowsProps) {
  const opening = useRef(false);
  const [busy, setBusy] = useState<string>(), [error, setError] = useState<string>();
  const outputs = owner.snapshot?.outputs ?? [];
  async function open<T extends SessionOutput>(output: T, action: (output: T, current: () => boolean) => void | Promise<void>) {
    if (opening.current) return;
    opening.current = true;
    const key = sessionOutputKey(output); setBusy(key); setError(undefined);
    try {
      const current = await owner.admit(output);
      if (!current) throw new Error(owner.error ?? 'This saved output changed. Select its current row to open it.');
      await action(output, current);
    } catch (error) { setError(error instanceof Error ? error.message : 'The saved output could not be opened.'); }
    finally { opening.current = false; setBusy(undefined); }
  }
  return <>
    <ul className="dock-suggested-list" aria-label="Suggested outputs">
      {outputs.map(output => <li key={sessionOutputKey(output)}>
        <button type="button" disabled={!owner.enabled || Boolean(busy)} onClick={() => void open(output, onOpen)} title={'path' in output ? output.path : output.kind === 'website' ? output.url : output.resourceUri}>
          <span className="dock-suggested-icon">{output.kind === 'generated-image' && owner.enabled
            ? <GeneratedThumbnail output={output} images={images}/>
            : output.kind === 'file' || output.kind === 'generated-image' ? <FileTypeIcon path={output.path}/> : <Icon name={output.kind === 'website' || output.kind === 'html-preview' ? 'globe' : 'compose'}/>}</span>
          <span>{output.label}</span>{busy === sessionOutputKey(output) && <span role="status">Opening…</span>}
        </button>
        {output.kind === 'html-preview' && onSource && <button type="button" className="dock-suggested-source" aria-label={`View source of ${output.label}`} disabled={!owner.enabled || Boolean(busy)} onClick={() => void open(output, onSource)}><FileTypeIcon path={output.path}/></button>}
      </li>)}
    </ul>
    {(error || owner.error) && <p className="dock-suggested-message" role="alert">{error ?? owner.error} <button type="button" disabled={!owner.enabled} onClick={() => { setError(undefined); void owner.read(); }}>Refresh outputs</button></p>}
    {owner.snapshot?.warnings.map(message => <p className="dock-suggested-message" key={message}>{message}</p>)}
    {owner.snapshot?.truncated && <p className="dock-suggested-message">Showing the newest 100 saved outputs from the retained history window.</p>}
  </>;
}
