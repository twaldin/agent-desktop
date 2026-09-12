import { App } from "../../../apps/desktop/node_modules/@modelcontextprotocol/ext-apps";
import { EmptyResultSchema, ResourceUpdatedNotificationSchema } from "../../../apps/desktop/node_modules/@modelcontextprotocol/core";
const app = new App({ name: "Counter fixture", version: "1.0.0" }, {});
document.body.innerHTML = '<h1>Counter app</h1><p id="count">Connecting…</p><button id="increment">Increment</button><button id="watch">Watch counter</button><button id="unwatch">Stop watching</button><p id="resource-count">Not watching</p><button id="notes">Read notes</button><button id="link">Open documentation</button><p id="result"></p>';
const events: unknown[] = []; Object.assign(window, { mcpEvents: events });
for (const type of ['pointerdown', 'click']) document.addEventListener(type, event => { events.push({ type, trusted: event.isTrusted, id: (event.target as HTMLElement)?.id }); });
const result = document.querySelector<HTMLElement>('#result')!;
app.ontoolresult = value => { document.querySelector('#count')!.textContent = String(value.content?.[0]?.type === 'text' ? value.content[0].text : 'Invalid count'); };
document.querySelector('#increment')!.addEventListener('click', () => { void app.callServerTool({ name: 'increment', arguments: { by: 1 } }).then(value => { document.querySelector('#count')!.textContent = String(value.content[0]?.type === 'text' ? value.content[0].text : 'Invalid count'); }).catch(error => { result.textContent = String(error); }); });
document.querySelector('#notes')!.addEventListener('click', () => { void app.readServerResource({ uri: 'fixture://notes' }).then(value => { result.textContent = value.contents.map(item => 'text' in item ? item.text : '').join(''); }).catch(error => { result.textContent = String(error); }); });
document.querySelector('#link')!.addEventListener('click', () => { void app.openLink({ url: 'https://example.invalid/mcp-documentation' }).then(value => { result.textContent = value.isError ? 'Link cancelled' : 'Link opened'; }); });

app.setNotificationHandler("notifications/resources/updated", { params: ResourceUpdatedNotificationSchema.shape.params }, async params => {
  if (params.uri !== "fixture://counter") return;
  const value = await app.readServerResource({ uri: params.uri });
  document.querySelector('#resource-count')!.textContent = value.contents.map(item => 'text' in item ? item.text : '').join('');
});
document.querySelector('#watch')!.addEventListener('click', () => { void app.request({ method: 'resources/subscribe', params: { uri: 'fixture://counter' } }, EmptyResultSchema).then(() => { document.querySelector('#resource-count')!.textContent = 'Watching'; }).catch(error => { result.textContent = String(error); }); });
document.querySelector('#unwatch')!.addEventListener('click', () => { void app.request({ method: 'resources/unsubscribe', params: { uri: 'fixture://counter' } }, EmptyResultSchema).then(() => { document.querySelector('#resource-count')!.textContent = 'Stopped'; }).catch(error => { result.textContent = String(error); }); });

await app.connect();
