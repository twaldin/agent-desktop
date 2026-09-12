import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import type { Api, AssistantMessage } from '@oh-my-pi/pi-ai';
import { AssistantMessageEventStream } from '@oh-my-pi/pi-ai/utils/event-stream';
/** The model's deterministic tool selections; native dispatch, write/read/image
 * tools, MCP subprocess and saved AgentSession messages remain production. */
export default function(pi: ExtensionAPI) {
  pi.registerProvider('html-contract', { baseUrl: 'https://controlled.invalid', apiKey: 'inert-local-fixture', api: 'html-contract-api' as Api,
    models: [{ id: 'controlled', name: 'HTML preview contract', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = new AssistantMessageEventStream();
      const first = context.messages.findLastIndex(message => message.role === 'user');
      const results = context.messages.slice(first + 1).filter(message => message.role === 'toolResult');
      const prompt = JSON.stringify(context.messages[first]);
      const steps = prompt.includes('html-prepare') ? [
        { name: 'write', arguments: { path: 'site/index.html', content: '<!doctype html><title>Original HTML</title><link rel="stylesheet" href="style.css"><h1 id="heading">Before edit</h1><img src="image.svg"><a style="position:absolute;left:8px;top:120px;width:200px;height:40px" href="about.html">About saved output</a><script src="app.js"></script>' } },
        { name: 'write', arguments: { path: 'site/about.html', content: '<!doctype html><title>Saved relative page</title><h1>Saved relative page</h1><a href="index.html">Return</a>' } },
        { name: 'write', arguments: { path: 'site/style.css', content: 'h1 { color: rgb(12, 100, 180); }' } },
        { name: 'write', arguments: { path: 'site/app.js', content: 'document.body.dataset.script = "original-recorded-script"; document.querySelector("#heading").textContent += " / linked JS";' } },
        { name: 'write', arguments: { path: 'site/image.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="green"/></svg>' } },
      ] : [{ name: 'edit', arguments: { path: 'site/index.html', old_string: 'Before edit', new_string: 'Actual native edited HTML' } }];
      const tool = steps[results.length];
      if (tool && process.env.HTML_PROVIDER_LOG) appendFileSync(process.env.HTML_PROVIDER_LOG, JSON.stringify(tool) + '\n');
      const message: AssistantMessage = { role: 'assistant', content: tool ? [{ type: 'toolCall', id: crypto.randomUUID(), ...tool }] : [{ type: 'text', text: 'The edited website is ready.' }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        const call = message.content[0];
        if (call?.type === 'toolCall') { stream.push({ type: 'toolcall_start', contentIndex: 0, partial: { ...message, content: [{ ...call, arguments: {} }] } }); stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message }); stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message }); }
        stream.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', message });
      });
      return stream;
    },
  });
}
