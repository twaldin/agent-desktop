import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SESSION_PLAN_OWNER_HEADER } from "../../../packages/shared/src/session-plan";
import { SESSION_TODOS_OWNER_HEADER } from "../../../packages/shared/src/session-todos";
import { requestPlanExternalEditorCapabilities, requestPlanExternalEditorList } from "../../desktop/src/main/plan-external-editor-client";
import { requestTodoExternalEditorCapabilities, requestTodoExternalEditorList } from "../../desktop/src/main/todo-external-editor-client";

// Exercise the actual server dispatch branches with unavailable services. The
// outer authentication middleware and a working terminal bundle are separate
// contracts; the regression is the response consumed by the desktop clients.
const source = readFileSync(process.env.EDITOR_UNAVAILABLE_SERVER ?? new URL("./server.ts", import.meta.url), "utf8");
const start = source.indexOf("        const editorRoute = ");
const end = source.indexOf("        const treeResponse = ", start);
if (start < 0 || end < start) throw new Error("External editor server routes not found");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`
  async function route(request: Request, hostId: string) {
    const url = new URL(request.url), store = { host: { id: hostId } };
    const planExternalEditorHttp = undefined, todoExternalEditorHttp = undefined;
    ${source.slice(start, end)}
    throw new Error("Unmatched editor route");
  }
`);
const route = new Function("SESSION_PLAN_OWNER_HEADER", "SESSION_TODOS_OWNER_HEADER", `${compiled}; return route;`)(
  SESSION_PLAN_OWNER_HEADER, SESSION_TODOS_OWNER_HEADER,
) as (request: Request, hostId: string) => Promise<Response>;

for (const [kind, header] of [["plan", SESSION_PLAN_OWNER_HEADER], ["todos", SESSION_TODOS_OWNER_HEADER]] as const) {
  test(`${kind} unavailable responses retain the original host on every editor action`, async () => {
    for (const action of ["capabilities", "list", "start", "status", "cancel", "recovery"]) {
      const response = await route(new Request(`http://127.0.0.1/v1/sessions/original/${kind}/editor/${action}`, {
        method: action === "capabilities" || action === "list" ? "GET" : "POST",
        headers: { [header]: "original-host" },
      }), "original-host");
      expect(response.status).toBe(503);
      expect(response.headers.get(header)).toBe("original-host");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ error: { code: "NATIVE_TERMINAL_BUNDLE_MISSING" } });
    }
  });
}

for (const [name, inspect] of [
  ["Plan capabilities", requestPlanExternalEditorCapabilities], ["Plan list", requestPlanExternalEditorList],
  ["Todo capabilities", requestTodoExternalEditorCapabilities], ["Todo list", requestTodoExternalEditorList],
] as const) {
  test(`${name} reports unavailable while refusing a foreign host`, async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) =>
      route(new Request(input, init), "original-host"), { preconnect() {} }) as typeof fetch;
    try {
      const endpoint = { origin: "http://127.0.0.1", hostId: "original-host", token: "test-only" };
      await expect(inspect(endpoint, "original")).rejects.toMatchObject({ status: 503, code: "NATIVE_TERMINAL_BUNDLE_MISSING" });
      await expect(inspect({ ...endpoint, hostId: "foreign-host" }, "original")).rejects.toMatchObject({ status: 409, code: "OWNER_MISMATCH" });
    } finally { globalThis.fetch = previous; }
  });
}
