import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { CallToolResultSchema, ReadResourceRequestSchema, ReadResourceResultSchema, ListResourcesResultSchema, ListResourceTemplatesResultSchema } from "@modelcontextprotocol/core";
import { cloneMcpJson, type McpJson, type NativeMcpAppResource, type NativeMcpAppSelection } from "@agent-desktop/shared";
import type { McpAppController } from "./mcp-app-controller";
import "./mcp-app-panel.css";
const message = (error: unknown) => error instanceof Error ? error.message : "The MCP app operation could not be confirmed.";
export function mcpSandboxDocument(resource: NativeMcpAppResource): string {
  const policy = resource.csp;
  const sources = (values?: string[]) => values?.length ? values.join(" ") : "'none'";
  const csp = `default-src 'none'; script-src 'unsafe-inline' ${(policy?.resourceDomains ?? []).join(" ")}; style-src 'unsafe-inline' ${(policy?.resourceDomains ?? []).join(" ")}; img-src data: blob: ${(policy?.resourceDomains ?? []).join(" ")}; font-src data: ${(policy?.resourceDomains ?? []).join(" ")}; connect-src ${sources(policy?.connectDomains)}; frame-src ${sources(policy?.frameDomains)}; base-uri ${sources(policy?.baseUriDomains)}; form-action 'none'; object-src 'none'`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp.replaceAll('"', '&quot;')}"><meta name="referrer" content="no-referrer">${resource.html}`;
}
function ExternalLinkDialog({ url, settle }: { url: string; settle(allowed: boolean): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} aria-label="Open external link" className="app-dialog mcp-app-link" onCancel={event => { event.preventDefault(); settle(false); }}>
    <p>Open this link in your browser?</p><p>{url}</p><div className="dialog-footer"><button autoFocus onClick={() => settle(false)}>Cancel</button><button onClick={() => settle(true)}>Open link</button></div>
  </dialog>;
}
function McpFrame({ controller, resource, onError }: { controller: McpAppController; resource: NativeMcpAppResource; onError(message: string): void }) {
  const frame = useRef<HTMLIFrameElement>(null), report = useRef(onError); report.current = onError;
  const [link, setLink] = useState<{ url: string; settle(allowed: boolean): void }>();
  const pendingLink = useRef<typeof link>(undefined);
  useLayoutEffect(() => {
    const element = frame.current!, originalWindow = element.contentWindow!;
    let alive = true, loaded = false;
    const host = new AppBridge(null, { name: "Agent Desktop", version: "0.1.0" }, { serverTools: {}, serverResources: {}, openLinks: {} }, {
      hostContext: { theme: document.documentElement.dataset.theme === "light" ? "light" : "dark", displayMode: "inline", availableDisplayModes: ["inline"], containerDimensions: { width: element.clientWidth, height: element.clientHeight } },
    });
    const assertCurrent = () => { if (!alive || element.contentWindow !== originalWindow) throw new Error("The original app document has retired."); };
    const call = async (method: Parameters<McpAppController["request"]>[0], params: unknown) => {
      assertCurrent(); const result = await controller.request(method, cloneMcpJson(params, method === "openai/resources/write" ? 2 * 1024 * 1024 : 32_768) as Record<string, McpJson>); assertCurrent(); return result;
    };
    host.oncalltool = async params => CallToolResultSchema.parse(await call("tools/call", params));
    host.setRequestHandler("resources/subscribe", { params: ReadResourceRequestSchema.shape.params }, params => call("resources/subscribe", params));
    host.setRequestHandler("resources/unsubscribe", { params: ReadResourceRequestSchema.shape.params }, params => call("resources/unsubscribe", params));
    host.onreadresource = async params => ReadResourceResultSchema.parse(await call("resources/read", params));
    host.setRequestHandler("openai/resources/write", { params: ReadResourceRequestSchema.shape.params.passthrough() }, params => call("openai/resources/write", params));
    host.onlistresources = async params => ListResourcesResultSchema.parse(await call("resources/list", params ?? {}));
    host.onlistresourcetemplates = async params => ListResourceTemplatesResultSchema.parse(await call("resources/templates/list", params ?? {}));
    host.oninitialized = () => {
      if (!alive) return;
      void (async () => {
        let cursor = 0;
        void (async () => {
          while (alive) {
            const batch = await controller.events(cursor); assertCurrent();
            for (const uri of batch.uris) { assertCurrent(); await host.notification({ method: "notifications/resources/updated", params: { uri } }); }
            cursor = batch.sequence;
          }
        })().catch(error => { if (alive) report.current(message(error)); });
        const arguments_ = controller.initialArguments();
        if (arguments_ !== undefined) { await host.sendToolInput({ arguments: arguments_ }); assertCurrent(); }
        const result = CallToolResultSchema.parse(await controller.initialResult()); assertCurrent();
        await host.sendToolResult(result);
      })().catch(error => { if (alive) report.current(message(error)); });
    };
    host.onopenlink = async ({ url }) => {
      assertCurrent(); const target = new URL(url);
      if (!["https:", "http:"].includes(target.protocol) || target.username || target.password) return { isError: true };
      const allowed = await new Promise<boolean>(settle => { pendingLink.current?.settle(false); pendingLink.current = { url: target.href, settle }; setLink(pendingLink.current); });
      assertCurrent(); if (!allowed) return { isError: true };
      await controller.bridge.openExternal(target.href); return {};
    };
    const navigation = () => {
      if (!loaded) { loaded = true; return; }
      alive = false; void host.close(); void controller.close().catch(error => report.current(message(error)));
      report.current("The app document navigated. Open the original app again deliberately.");
    };
    element.addEventListener("load", navigation);
    const resize = new ResizeObserver(() => { if (alive) host.setHostContext({ containerDimensions: { width: element.clientWidth, height: element.clientHeight } }); });
    resize.observe(element);
    void host.connect(new PostMessageTransport(originalWindow, originalWindow)).then(() => { if (alive) element.srcdoc = mcpSandboxDocument(resource); }, error => report.current(message(error)));
    return () => {
      alive = false; resize.disconnect(); element.removeEventListener("load", navigation);
      pendingLink.current?.settle(false); pendingLink.current = undefined;
      void host.close().catch(error => report.current(message(error)));
    };
  }, [controller, resource]);
  return <><iframe ref={frame} title={controller.app.title} className="mcp-app-frame" sandbox="allow-scripts" referrerPolicy="no-referrer"/>
    {link && <ExternalLinkDialog url={link.url} settle={allowed => { link.settle(allowed); setLink(undefined); }}/>}</>;
}
export function McpAppPanel({ controller, connected, initialSelection, focusOnMount }: { controller: McpAppController; connected: boolean; initialSelection?: NativeMcpAppSelection; focusOnMount?(element: HTMLElement): void }) {
  const panel = useRef<HTMLElement>(null), initialFocus = useRef(focusOnMount);
  useLayoutEffect(() => { if (panel.current) initialFocus.current?.(panel.current); }, []);
  const [resource, setResource] = useState<NativeMcpAppResource>(), [error, setError] = useState<string>(), [loading, setLoading] = useState(false);
  const generation = useRef(0), initial = useRef(initialSelection);
  useLayoutEffect(() => controller.subscribeClose(() => { setResource(undefined); setLoading(false); }), [controller]);
  useLayoutEffect(() => { controller.connected(connected); generation.current++; if (!connected) { setLoading(false); setResource(undefined); setError("Connect to the original host, then open the app again."); } }, [controller, connected]);
  const open = async (selection?: NativeMcpAppSelection) => {
    const token = generation.current; setLoading(true); setError(undefined);
    try { const value = await controller.open(selection); if (token === generation.current) setResource(value); }
    catch (error) { if (token === generation.current) setError(message(error)); }
    finally { if (token === generation.current) setLoading(false); }
  };
  useEffect(() => { const selection = initial.current; initial.current = undefined; if (selection && connected) void open(selection); return () => { generation.current++; void controller.close().catch(() => {}); }; }, [controller]);
  return <section ref={panel} tabIndex={-1} className="mcp-app-panel" aria-label={`${controller.app.title} app`}>
    {error && <p role="alert">{error}</p>}
    {resource && connected && !error ? <McpFrame controller={controller} resource={resource} onError={value => { setError(value); setResource(undefined); void controller.close().catch(error => setError(message(error))); }}/>
      : <div className="mcp-app-empty"><p>{loading ? "Opening app…" : `${controller.app.title} · ${controller.app.serverName}`}</p><button disabled={!connected || loading} onClick={() => void open()}>Open app</button></div>}
  </section>;
}
