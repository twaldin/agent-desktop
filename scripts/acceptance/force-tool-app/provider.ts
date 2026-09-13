import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface ControlledRequest {
  model?: string; stream?: boolean;
  tool_choice?: string | { type?: string; function?: { name?: string } };
  tools?: Array<{ type?: string; function?: { name?: string } }>;
  messages?: Array<{ role?: string; content?: unknown }>;
}

/** Controlled local HTTP fixture. Real native request builders and the real read
 * tool run; SSE responses are authored here and are never vendor proof. */
export async function startControlledProvider(root: string, fixtureFile: string, nonce: string) {
  const directory = join(root, 'provider'); await mkdir(directory);
  let sequence = 0, stopping = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.hostname !== '127.0.0.1' || url.pathname !== '/v1/chat/completions' || request.method !== 'POST')
        return new Response('Only the controlled chat-completions endpoint is available.', { status: 400 });
      const index = ++sequence, body = await request.json() as ControlledRequest;
      await writeFile(join(directory, `request-${index}.json`), JSON.stringify({ index, path: url.pathname, body, time: Date.now() }, null, 2));
      await appendFile(join(directory, 'requests.jsonl'), JSON.stringify({ index, body }) + '\n');
      try {
        if (body.model !== 'controlled' || body.stream !== true) throw new Error('Unexpected model or non-streaming native request.');
        const choice = body.tool_choice;
        const named = typeof choice === 'object' && choice?.type === 'function' && choice.function?.name === 'read';
        const final = body.tool_choice === 'none';
        if (!named && !final) throw new Error('Expected actual named read or none mapping, not auto/missing tool choice.');
        if (named && !body.tools?.some(tool => tool.type === 'function' && tool.function?.name === 'read'))
          throw new Error('The real read tool schema is absent.');
        if (final && !body.messages?.some(message => message.role === 'tool' && JSON.stringify(message.content).includes(nonce)))
          throw new Error('Final request lacks the real read result nonce.');
        const deadline = Date.now() + 100_000;
        while (!await Bun.file(join(directory, `release-${index}`)).exists()) {
          if (stopping || request.signal.aborted || Date.now() > deadline) throw new Error('Controlled HTTP response hold ended without release.');
          await Bun.sleep(25);
        }
        const base = { id: `chatcmpl-force-${index}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'controlled' };
        const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        const payload = named
          ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_force_${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: fixtureFile }) } }] }) + chunk({}, 'tool_calls')
          : chunk({ role: 'assistant', content: `Controlled HTTP final response after actual read: ${nonce}` }) + chunk({}, 'stop');
        return new Response(payload + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
      } catch (cause) {
        await appendFile(join(directory, 'failures.jsonl'), JSON.stringify({ index, error: String(cause) }) + '\n');
        return new Response(JSON.stringify({ error: { message: String(cause), type: 'fixture_error' } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, async stop() { stopping = true; await server.stop(true); } };
}
