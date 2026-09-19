// Production worker entry behind a controlled provider and disposable environment.
// Response corruption scenarios exercise the real parent parsers and owner fences.
import assert from "node:assert/strict";
import path from "node:path";

type RequestMessage = { type?: string; id?: string; operation?: string };
const requests = new Map<string, string>();
process.on("message", (message: unknown) => {
  const value = message as RequestMessage;
  if (value?.type === "request" && typeof value.id === "string" && typeof value.operation === "string")
    requests.set(value.id, value.operation);
});
const nativeSend = process.send?.bind(process);
if (!nativeSend) throw new Error("The Plan external-editor fixture requires the actual worker IPC channel.");
process.send = ((message: unknown, ...args: unknown[]) => {
  let outgoing = message;
  if (message && typeof message === "object" && "type" in message && message.type === "response"
    && "id" in message && typeof message.id === "string" && "ok" in message && message.ok === true) {
    const operation = requests.get(message.id); requests.delete(message.id);
    if (operation === "getTodoExternalEditorAvailable" && process.env.TODO_EDITOR_REPLY_SCENARIO === "invalid-availability")
      outgoing = { ...message, value: "yes" };
    if (operation === "prepareTodoExternalEditor" && "value" in message && message.value && typeof message.value === "object") {
      if (process.env.TODO_EDITOR_REPLY_SCENARIO === "wrong-cwd")
        outgoing = { ...message, value: { ...message.value, cwd: path.join(process.env.HOME!, "replacement-project") } };
      if (process.env.TODO_EDITOR_REPLY_SCENARIO === "oversized-environment")
        outgoing = { ...message, value: { ...message.value,
          environment: Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [`SAFE_${index}`, "value"])) } };
    }
  }
  return Reflect.apply(nativeSend, process, [outgoing, ...args]);
}) as typeof process.send;

globalThis.fetch = Object.assign(async () => { throw new Error("Network is disabled in the native Todo editor fixture"); },
  { preconnect: () => { throw new Error("Preconnect disabled"); } }) as typeof fetch;
await import("../entry");
