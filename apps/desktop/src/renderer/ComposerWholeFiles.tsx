import type { WholeFileAttachment } from '@agent-desktop/shared';
import { TreeFileIcon } from './TreeFileIcon';
import { Icon } from './Icons';
import './composer-whole-files.css';

/** Whole-file identities remain distinct from immutable selected-text snapshots. */
export function ComposerWholeFiles({ attachments, disabled, onRemove, onFocusComposer }: {
  attachments?: readonly WholeFileAttachment[]; disabled?: boolean;
  onRemove(id: string): void; onFocusComposer(): void;
}) {
  if (!attachments?.length) return null;
  return <div className="composer-whole-files" aria-label="Attached files">{attachments.map(file => <span className="composer-whole-file" key={file.id} title={file.source.path}>
    <TreeFileIcon path={file.source.path}/><span>{file.source.path.split('/').at(-1)}</span>
    <button type="button" disabled={disabled} aria-label={`Remove ${file.source.path.split('/').at(-1)} attachment`} onClick={() => { onRemove(file.id); onFocusComposer(); }}
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); onFocusComposer(); } }}><Icon name="close"/></button>
  </span>)}</div>;
}
