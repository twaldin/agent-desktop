import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IpcMainInvokeEvent } from "electron";
import { SyntaxKind } from "typescript/unstable/ast";
import { createScanner } from "typescript/unstable/ast/scanner";
import type { McpOwnerRequest, McpOwnerResult, McpOwnerSnapshot } from "@agent-desktop/shared";
import { McpOwnerMainChannels } from "./mcp-owner-main-channels";

const endpoint = { hostId: "original-host", origin: "http://original.invalid", token: "controlled" };
const snapshot = (ownerId: string): McpOwnerSnapshot => ({ ownerId, epoch: `epoch:${ownerId}`, cwd: "/original", projectId: null,
  interactions: [], catalogue: { available: true, canOpenApps: true, epoch: "catalogue", revision: 1, servers: [] } });
const event = (id: number) => { const frame = {}, sender = { id, mainFrame: frame, isDestroyed: () => false };
  return { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent; };

function mainWiring(sourceText: string): string {
  const scanner = createScanner(true, undefined, sourceText), tokens: Array<{ kind: SyntaxKind; start: number; end: number; braces: number; parens: number; brackets: number; text: string }> = [];
  let braces = 0, parens = 0, brackets = 0, kind: SyntaxKind;
  while ((kind = scanner.scan()) !== SyntaxKind.EndOfFile) {
    tokens.push({ kind, start: scanner.getTokenStart(), end: scanner.getTokenEnd(), braces, parens, brackets, text: scanner.getTokenText() });
    if (kind === SyntaxKind.OpenBraceToken) braces++; else if (kind === SyntaxKind.CloseBraceToken) braces--;
    else if (kind === SyntaxKind.OpenParenToken) parens++; else if (kind === SyntaxKind.CloseParenToken) parens--;
    else if (kind === SyntaxKind.OpenBracketToken) brackets++; else if (kind === SyntaxKind.CloseBracketToken) brackets--;
  }
  const topLevel = (token: (typeof tokens)[number]) => !token.braces && !token.parens && !token.brackets;
  const declarationStart = (declarationKind: SyntaxKind, name: string) => tokens.findIndex((token, index) => token.kind === declarationKind && topLevel(token) && tokens[index + 1]?.kind === SyntaxKind.Identifier && tokens[index + 1]?.text === name);
  const variable = (name: string) => { const start = declarationStart(SyntaxKind.ConstKeyword, name);
    if (start < 0) return undefined; const end = tokens.findIndex((token, index) => index > start && token.kind === SyntaxKind.SemicolonToken && topLevel(token));
    if (end < 0) throw new Error(`The ${name} main declaration changed.`); return sourceText.slice(tokens[start]!.start, tokens[end]!.end); };
  const functionDeclaration = (name: string) => { const start = declarationStart(SyntaxKind.FunctionKeyword, name);
    if (start < 0) throw new Error(`The ${name} main function changed.`); const open = tokens.findIndex((token, index) => index > start && token.kind === SyntaxKind.OpenBraceToken && !token.braces);
    const end = tokens.findIndex((token, index) => index > open && token.kind === SyntaxKind.CloseBraceToken && token.braces === 1);
    if (open < 0 || end < 0) throw new Error(`The ${name} main function is incomplete.`); return sourceText.slice(tokens[start]!.start, tokens[end]!.end); };
  const closeGate = variable("windowCloseGate");
  if (!closeGate) throw new Error("The main close gate declaration changed.");
  const selected = `${variable("htmlPreviewDocuments") ?? ""}\n${variable("htmlPreviewDrains") ?? ""}\n${variable("mcpOwnerDocuments") ?? ""}\n${functionDeclaration("retireMcpAppDocument")}\n${closeGate}\nreturn {retireMcpAppDocument,prepareQuit:windowCloseGate.options.prepareQuit};`;
  return new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(selected);
}

// Exercises the same registrar used by main: the channel must exist, dispatch through
// the captured sender document, and retire only that document's native owners.
test("main MCP owner channel registers, dispatches, and drains the exact document", async () => {
  let handler: ((event: IpcMainInvokeEvent, hostId: string, request: McpOwnerRequest) => Promise<McpOwnerResult>) | undefined;
  const calls: Array<{ ownerId: string; type: string }> = [];
  const channels = new McpOwnerMainChannels({
    ipcMain: { handle: (name, value) => { expect(name).toBe("host:mcp-owner"); handler = value as NonNullable<typeof handler>; } },
    available: () => true,
    assertTrusted: () => {},
    connect: async () => endpoint,
    request: async (_endpoint, request) => { calls.push({ ownerId: request.ownerId, type: request.type });
      return request.type === "retire" ? { closed: true } : snapshot(request.ownerId); },
  });
  expect(handler).toBeDefined();
  const first = event(7), second = event(8);
  await handler!(first, endpoint.hostId, { type: "acquire", ownerId: "first", target: { projectId: null } });
  await handler!(second, endpoint.hostId, { type: "acquire", ownerId: "second", target: { projectId: null } });
  channels.retireDocument(first.sender.id); await channels.drain();
  expect(calls).toEqual([{ ownerId: "first", type: "acquire" }, { ownerId: "second", type: "acquire" }, { ownerId: "first", type: "retire" }]);
  await handler!(second, endpoint.hostId, { type: "read", ownerId: "second", epoch: "epoch:second" });
  channels.retireDocument(second.sender.id); await channels.drain();
  expect(calls.slice(-2)).toEqual([{ ownerId: "second", type: "read" }, { ownerId: "second", type: "retire" }]);
});

test("maintained main registers the MCP owner channel and joins document cleanup", async () => {
  const sourcePath = process.env.AGENT_DESKTOP_MCP_MAIN_SOURCE ?? new URL("./main.ts", import.meta.url).pathname;
  const sourceBefore = readFileSync(sourcePath, "utf8"), sourceHash = createHash("sha256").update(sourceBefore).digest("hex");
  let handler: ((event: IpcMainInvokeEvent, hostId: string, request: McpOwnerRequest) => Promise<McpOwnerResult>) | undefined;
  const calls: string[] = [], release = () => {};
  const ipcMain = { handle: (name: string, value: typeof handler) => { if (name === "host:mcp-owner") handler = value; } };
  const install = new Function("McpOwnerMainChannels", "WindowCloseGate", "ipcMain", "shuttingDown", "assertTrustedSender", "endpointFor", "requestMcpOwner",
    "mcpAppDocuments", "mcpAppDocumentDrains", "modifierWatches", mainWiring(sourceBefore)) as (...args: any[]) => {
      retireMcpAppDocument(senderId: number): void; prepareQuit(): Promise<() => void>;
    };
  class ControlledCloseGate { constructor(readonly options: { prepareQuit(): Promise<() => void> }) {} }
  const wiring = install(McpOwnerMainChannels, ControlledCloseGate, ipcMain, false, () => {}, async () => endpoint,
    async (_endpoint: typeof endpoint, request: McpOwnerRequest) => { calls.push(request.type); return request.type === "retire" ? { closed: true } : snapshot(request.ownerId); },
    new Map(), new Set(), { pauseAndDrain: async () => release });
  console.log(JSON.stringify({ mainSource: sourcePath, sha256: sourceHash }));
  expect(handler).toBeDefined();
  const document = event(17);
  await handler!(document, endpoint.hostId, { type: "acquire", ownerId: "main-owner", target: { projectId: null } });
  wiring.retireMcpAppDocument(document.sender.id);
  expect(await wiring.prepareQuit()).toBe(release);
  expect(calls).toEqual(["acquire", "retire"]);
  expect(createHash("sha256").update(readFileSync(sourcePath)).digest("hex")).toBe(sourceHash);
});
