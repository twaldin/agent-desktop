import { parse } from 'tldts';

const localHost = (host: string) => ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(host.toLowerCase()) || host.toLowerCase().endsWith('.localhost');

/** Idle presentation only. The editable value always retains the complete URL. */
export function browserAddressLabel(value: string): string {
  if (value === 'about:blank') return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return value;
    if (localHost(url.hostname)) {
      const label = url.toString().replace(/^https?:\/\//i, '');
      return url.pathname === '/' && !url.search && !url.hash ? label.slice(0, -1) : label;
    }
    return url.protocol === 'https:' ? url.host.replace(/^www\./i, '') : `http://${url.host}`;
  } catch { return value; }
}
export function browserExternalAddress(value: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

/** Match the reference's URL/search distinction, using public and private suffixes. */
export function browserNavigationAddress(value: string): string {
  const input = value.trim();
  if (!input) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^about:/i.test(input)) return input;
  // Host-local files need an owning-host operation; never leak their paths into a search.
  if (/^(?:\/(?!\/)|[a-z]:[\\/]|\\\\)/i.test(input)) throw new Error('Opening a host-local file in the browser is not available yet.');
  const authority = input.split(/[/?#]/, 1)[0];
  let host = authority, hasPort = false, validHost = Boolean(host) && !host.includes('@');
  if (host.startsWith('[')) {
    const match = /^(\[[^\]]+\])(?::([0-9]+))?$/.exec(host);
    validHost &&= Boolean(match);
    if (match) { host = match[1]; hasPort = match[2] !== undefined; }
  } else if (host.includes(':')) {
    const match = /^([^:]+):([0-9]+)$/.exec(host);
    validHost &&= Boolean(match);
    if (match) { host = match[1]; hasPort = true; }
  }
  if (validHost && localHost(host)) return `http://${input}`;
  if (validHost && !/\s/.test(input)) {
    let ip = false;
    if (host.startsWith('[')) { try { ip = new URL(`https://${host}`).hostname.startsWith('['); } catch {} }
    else ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) && host.split('.').every(part => Number(part) <= 255);
    const domain = parse(host, { allowPrivateDomains: true });
    if (ip || (!host.startsWith('[') && (hasPort || host.startsWith('www.') || domain.domain !== null && (domain.isIcann || domain.isPrivate)))) return `https://${input}`;
  }
  return `https://www.google.com/search?${new URLSearchParams({ q: input })}`;
}
