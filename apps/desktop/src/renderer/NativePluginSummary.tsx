import type {ReactNode} from 'react';
import type { NativePlugin } from '@agent-desktop/shared';
import { Icon } from './Icons';
import { resolveTranscriptLink } from './transcript-links';
import './native-plugin-summary.css';

/** Public native metadata only; artwork is an application fallback. */
export function NativePluginSummary({plugin,disabled,onToggle,onOpenWebsite,actions}:{plugin:NativePlugin;disabled:boolean;onToggle():void;onOpenWebsite?(url:string):void;actions?:ReactNode}) {
 const website=plugin.homepage?resolveTranscriptLink(plugin.homepage):undefined;
 return <div className="native-plugin-summary">
  <div className="plugin-detail-artwork" aria-hidden="true"><Icon name="skill"/></div>
  <div className="integration-title plugin-detail-title">
   <h2>{plugin.title || plugin.name}</h2>
   <div className="plugin-detail-header-actions">{actions}{plugin.canToggle && <button type="button" className={`plugin-detail-enable ${plugin.enabled?'secondary-button':'primary-button'}`} aria-label={`${plugin.enabled?'Disable':'Enable'} ${plugin.title || plugin.name}`} aria-pressed={plugin.enabled} disabled={disabled} onClick={onToggle}>{plugin.enabled?<><Icon name="check"/>Enabled</>:'Enable'}</button>}</div>
  </div>
  {plugin.description && <p className="plugin-detail-description">{plugin.description}</p>}
  {!plugin.canToggle && <p className="integration-note">{plugin.configurationReason || 'Managed by native OMP configuration'}</p>}
  <section className="plugin-detail-information" aria-label="Plugin information">
   <h3>Information</h3>
   <dl>
    {plugin.category && <><dt>Category</dt><dd>{plugin.category}</dd></>}
    <dt>Version</dt><dd>{plugin.version}</dd>
    <dt>Website</dt><dd>{plugin.homepage ? website?.kind==='external'&&onOpenWebsite ? <a className="plugin-detail-website" href={website.url} onClick={event=>{event.preventDefault();onOpenWebsite(website.url);}}><span>{plugin.homepage}</span><Icon name="browserExternal"/></a> : <span title={website?.kind==='unavailable'?website.reason:undefined}>{plugin.homepage}</span> : <span className="plugin-detail-unavailable">Unavailable</span>}</dd>
    <dt>Installed for</dt><dd>{plugin.scope==='project'?'This project':'User'}{plugin.shadowed && ' · Shadowed'}</dd>
    <dt>Source</dt><dd>{plugin.kind==='marketplace'?'Marketplace':'Package'}</dd>
   </dl>
  </section>
 </div>;
}
