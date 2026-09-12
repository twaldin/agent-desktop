import type { IpcMainInvokeEvent } from "electron";
import type { McpOwnerRequest, McpOwnerResult } from "@agent-desktop/shared";
import type { HostEndpoint } from "./host-transport";
import { McpOwnerWindow } from "./mcp-owner-windows";

interface IpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): unknown;
}

/** Binds native MCP-directory owners to the exact renderer document that acquired them. */
export class McpOwnerMainChannels {
  readonly #documents = new Map<number, McpOwnerWindow>();
  readonly #drains = new Set<McpOwnerWindow>();

  constructor(private readonly options: {
    ipcMain: IpcRegistrar;
    available(): boolean;
    assertTrusted(event: IpcMainInvokeEvent): void;
    connect(hostId: string): Promise<HostEndpoint>;
    request(endpoint: HostEndpoint, request: McpOwnerRequest): Promise<McpOwnerResult>;
    reportCleanupError?(error: unknown): void;
  }) {
    options.ipcMain.handle("host:mcp-owner", (event, hostId: string, request: McpOwnerRequest) => {
      options.assertTrusted(event);
      const sender = event.sender, frame = event.senderFrame;
      let document = this.#documents.get(sender.id);
      if (!document) {
        document = new McpOwnerWindow({
          current: () => options.available() && !sender.isDestroyed() && sender.mainFrame === frame && this.#documents.get(sender.id) === document,
          connect: async ownerHostId => { const endpoint = await options.connect(ownerHostId); options.assertTrusted(event); return endpoint; },
          request: options.request,
        });
        this.#documents.set(sender.id, document);
      }
      return document.dispatch(hostId, request);
    });
  }

  retireDocument(senderId: number): void {
    const document = this.#documents.get(senderId);
    if (!document) return;
    this.#documents.delete(senderId);
    this.#drains.add(document);
    void document.retire().then(() => this.#drains.delete(document), error => this.options.reportCleanupError?.(error));
  }

  async drain(): Promise<void> {
    await Promise.all([...this.#drains].map(document => document.retire()));
  }
}
