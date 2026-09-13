import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
interface RequestBody {
  model?: string; stream?: boolean; tool_choice?: unknown;
  tools?: Array<{ function?: { name?: string } }>;
  messages?: Array<{ role?: string; content?: unknown }>;
}
/** Local controlled HTTP, never a replacement SDK/tool/host receipt. Native
 * write owns both local://plan.md and xd://propose execution and journal data. */
export async function startControlledProvider(root: string, nonce: string) {
  const directory = join(root, 'provider'); await mkdir(directory);
  const stages = new Map<string, number>(); let sequence = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.hostname !== '127.0.0.1' || url.pathname !== '/v1/chat/completions' || request.method !== 'POST') return new Response('Controlled endpoint only', { status: 400 });
      const index = ++sequence, body = await request.json() as RequestBody;
      await writeFile(join(directory, `request-${index}.json`), JSON.stringify({ index, path: url.pathname, body, time: Date.now() }, null, 2));
      try {
        if (body.model !== 'controlled' || body.stream !== true) throw new Error('Unexpected native model or non-streaming request.');
        const contents = (body.messages ?? []).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
        const caseName = ['keep', 'fresh', 'refine', 'save'].find(name => contents.includes(`PLAN_CASE:${name}:${nonce}`));
        if (!caseName) throw new Error('Request has no owning Plan case marker.');
        const refined = contents.includes(`PLAN_REFINE:${caseName}:${nonce}`), wave = `${caseName}:${refined ? 'refined' : 'initial'}`;
        const stage = stages.get(wave) ?? 0; stages.set(wave, stage + 1);
        const plan = `# Plan\n\nPLAN_CASE:${caseName}:${nonce}\n\n${refined ? 'Updated after actual native refinement input.' : 'Controlled local HTTP plan.'}\n\n- Inspect the owned project.\n- Report completion without changing project files.\n`;
        let delta: unknown, finish = 'stop';
        if (stage < 2) {
          if (!body.tools?.some(tool => tool.function?.name === 'write') || body.tool_choice === 'none') throw new Error('Native Plan request cannot execute its real write tool.');
          if (stage === 1 && !body.messages?.some(message => message.role === 'tool')) throw new Error('No native tool result preceded proposal.');
          const args = stage === 0 ? { path: 'local://plan.md', content: plan } : { path: 'xd://propose', content: 'plan' };
          delta = { role: 'assistant', tool_calls: [{ index: 0, id: `plan_call_${index}`, type: 'function', function: { name: 'write', arguments: JSON.stringify(args) } }] };
          finish = 'tool_calls';
        } else delta = { role: 'assistant', content: `Controlled Plan ${wave} response ${stage}. ${nonce}` };
        await appendFile(join(directory, 'responses.jsonl'), JSON.stringify({ index, wave, stage, delta, finish }) + '\n');
        const base = { id: `chatcmpl-plan-${index}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'controlled' };
        const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(chunk(delta) + chunk({}, finish) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
      } catch (cause) {
        await appendFile(join(directory, 'failures.jsonl'), JSON.stringify({ index, error: String(cause) }) + '\n');
        return new Response(JSON.stringify({ error: { message: String(cause), type: 'fixture_error' } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, async stop() { await server.stop(true); } };
}
