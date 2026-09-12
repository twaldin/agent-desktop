import { DeviceAccessConflictError, type DeviceAccessState } from "../../../packages/shared/src/device-access";
import type { HostStore } from "./store";

/** This route is served only after bearer authentication on the local listener. */
export class DeviceAccessHttp {
  constructor(private readonly store: HostStore, private readonly supported: boolean, private readonly changed: () => void) {}
  async route(request: Request, remote: boolean): Promise<Response | undefined> {
    if (new URL(request.url).pathname !== "/v1/device-access") return undefined;
    if (remote) return Response.json({ error: "Device access can only be changed or inspected on its home machine." }, { status: 403 });
    const state = (): DeviceAccessState => ({ hostId: this.store.host.id, supported: this.supported, policy: this.store.getDeviceAccessPolicy() });
    if (request.method === "GET") return Response.json(state(), { headers: { "Cache-Control": "no-store" } });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
    if (!this.supported) return Response.json({ error: "Tailscale discovery is disabled for this host." }, { status: 409 });
    try {
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 4096) throw new Error("Device access update is too large.");
      this.store.updateDeviceAccessPolicy(JSON.parse(raw));
      // Synchronous with the durable save: close denied streams before yielding or replying.
      this.changed();
      return Response.json(state(), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof DeviceAccessConflictError ? 409 : 400 });
    }
  }
}
