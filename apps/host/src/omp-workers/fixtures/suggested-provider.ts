import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import type { Api, AssistantMessage } from '@oh-my-pi/pi-ai';
import { AssistantMessageEventStream } from '@oh-my-pi/pi-ai/utils/event-stream';
/** The model's deterministic tool selections; native dispatch, write/read/image
 * tools, MCP subprocess and saved AgentSession messages remain production. */
export default function(pi: ExtensionAPI) {
  pi.registerProvider('suggested-contract', { baseUrl: 'https://controlled.invalid', apiKey: 'inert-local-fixture', api: 'suggested-contract-api' as Api,
    models: [{ id: 'controlled', name: 'Suggested output contract', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = new AssistantMessageEventStream();
      const first = context.messages.findLastIndex(message => message.role === 'user');
      const results = context.messages.slice(first + 1).filter(message => message.role === 'toolResult');
      const prompt = JSON.stringify(context.messages[first]);
      const steps = prompt.includes('many-outputs') ? Array.from({ length: 24 }, (_, i) => ({ name: 'write', arguments: { path: `output-${String(i).padStart(2, '0')}.md`, content: `# Saved output ${i}\n` } })) : prompt.includes('website-only') ? [] : prompt.includes('overwrite-output') ? [{ name: 'write', arguments: { path: 'summary.md', content: '# Newest saved output\n' } }] : [
        { name: 'read', arguments: { path: 'input.md' } },
        { name: 'write', arguments: { path: 'blocked/failed.pdf', content: 'This cannot be written.' } },
        { name: 'write', arguments: { path: 'summary.md', content: '# Original saved output\n' } },
        { name: 'generate_image', arguments: { subject: 'A single fixture pixel', provider: 'deepinfra' } },
        { name: 'read', arguments: { path: 'xd://' } },
        { name: 'write', arguments: { path: 'xd://mcp__fixture_report', content: '{"title":"Original report"}' } },
      ];
      const tool = steps[results.length];
      const message: AssistantMessage = { role: 'assistant', content: tool ? [{ type: 'toolCall', id: crypto.randomUUID(), ...tool }] : [{ type: 'text', text: prompt.includes('website-only') ? `Preview ${process.env.SUGGESTED_WEBSITE_URL ?? 'http://127.0.0.1:54321/'}` : 'Saved outputs are ready. The read input.md remains an input.' }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        const call = message.content[0];
        if (call?.type === 'toolCall') { stream.push({ type: 'toolcall_start', contentIndex: 0, partial: { ...message, content: [{ ...call, arguments: {} }] } }); stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message }); }
        stream.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', message });
      });
      return stream;
    },
  });
}
