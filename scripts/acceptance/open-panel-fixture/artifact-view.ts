import { App } from "../../../apps/desktop/node_modules/@modelcontextprotocol/ext-apps";
import { ResultSchema } from "../../../apps/desktop/node_modules/@modelcontextprotocol/core";
const app = new App({ name: "Artifact viewer fixture", version: "1" }, {});
document.body.innerHTML = '<h1 id="heading">Connecting…</h1><pre id="retained"></pre><textarea id="editor" aria-label="File contents"></textarea><button id="refresh">Refresh file</button><button id="save">Save file</button><button id="binary">Save binary</button><button id="foreign">Read foreign resource</button><p id="result"></p>';
const result = document.querySelector<HTMLElement>('#result')!, editor = document.querySelector<HTMLTextAreaElement>('#editor')!;
let file: { name: string; resourceUri: string } | undefined, etag: string | undefined;
const events: unknown[] = []; Object.assign(window, { mcpEvents: events });
for (const type of ['pointerdown', 'click']) document.addEventListener(type, event => events.push({ type, trusted: event.isTrusted, id: (event.target as HTMLElement)?.id }));
const report = (error: unknown) => { result.textContent = String(error); };
async function read() {
  if (!file) return;
  const value = await app.readServerResource({ uri: file.resourceUri });
  const meta = value._meta?.['openai/resource'] as { etag: string; writable: boolean };
  etag = meta.etag;
  const content = value.contents[0]; editor.value = content && 'text' in content ? content.text : content && 'blob' in content ? `Binary ${content.blob}` : '';
  result.textContent = 'File refreshed';
}
app.ontoolinput = value => { file = value.arguments?.file as typeof file; };
app.ontoolresult = value => {
  document.querySelector('#heading')!.textContent = file ? 'Original file viewer' : 'Saved report';
  document.querySelector('#retained')!.textContent = JSON.stringify(value.structuredContent);
  if (file) void read().catch(report);
  else { editor.hidden = true; for (const button of document.querySelectorAll('button')) button.hidden = true; }
};
document.querySelector('#refresh')!.addEventListener('click', () => void read().catch(report));
async function save(binary: boolean) {
  if (!file) throw new Error('No original file');
  const value = await app.request({ method: 'openai/resources/write', params: { uri: file.resourceUri, ifMatch: etag, ...(binary ? { blob: 'AAH/' } : { text: editor.value }) } }, ResultSchema);
  const outcome = value.outcome;
  if (outcome === 'saved') etag = value.etag as string;
  result.textContent = String(outcome);
}
document.querySelector('#save')!.addEventListener('click', () => void save(false).catch(report));
document.querySelector('#binary')!.addEventListener('click', () => void save(true).catch(report));
document.querySelector('#foreign')!.addEventListener('click', () => void app.readServerResource({ uri: 'codex-resource://foreign' }).then(() => { result.textContent = 'Unexpected foreign read'; }, report));
await app.connect();
