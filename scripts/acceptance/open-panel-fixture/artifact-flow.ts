import type { BrowserWindow } from 'electron';
import type { WindowStateStore } from '../../../apps/desktop/src/main/window-state';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export async function runArtifactFlow(flow: { window: BrowserWindow; evaluate(script: string): Promise<any>; wait(expression: string, label: string): Promise<void>; click(selector: string, text?: string): Promise<void>; key(key: string): Promise<void>; capture(name: string): Promise<void>; store: WindowStateStore; calls: unknown[]; setConnected(connected: boolean): void; fixture: string }) {
  const { window, evaluate, wait, click, capture, store } = flow;
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const frame = () => window.webContents.mainFrame.frames.find(value => value.url === 'about:srcdoc');
  const inspect = (script: string) => { const original = frame(); if (!original) throw new Error('Missing viewer SDK iframe'); return original.executeJavaScript(script, true); };
  const waitFrame = async (expression: string, label: string) => { for (let i = 0; i < 400; i++) { if (frame() && await inspect(expression)) return; await delay(50); } throw new Error('Timed out: ' + label); };
  const clickFrame = async (id: string) => {
    const outer = await evaluate('(()=>{const r=document.querySelector(".mcp-app-frame").getBoundingClientRect();return {x:r.x,y:r.y};})()');
    const inner = await inspect(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    if (!inner || typeof inner !== "object" || !("x" in inner) || typeof inner.x !== "number" || !("y" in inner) || typeof inner.y !== "number") throw new Error("Invalid iframe geometry");
    const point = { x: outer.x + inner.x, y: outer.y + inner.y };
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    flow.calls.push({ method: 'artifact-iframe-pointer', id, point }); await delay(100);
  };
  const approveIfRequired = async () => {
    for (let i = 0; i < 300; i++) {
      if (await evaluate('document.querySelector(".interaction-card") !== null')) {
        await click('.interaction-option', 'Approve'); await click('.interaction-actions button', 'Choose'); return;
      }
      if (frame() && await inspect('document.querySelector("#result")?.textContent === "File refreshed"')) return;
      await delay(50);
    }
    throw new Error('Viewer neither loaded nor requested its native permission');
  };
  const providerCalls = () => readFileSync(join(flow.fixture, 'mcp-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const assertNoReplay = () => { if (providerCalls().filter(value => value.method === 'tools/call' && value.params.name === 'report').length !== 1) throw new Error('Historical report tool was replayed'); };
  await wait('document.querySelector(".transcript-artifact-open") !== null', 'actual native completed artifact entry');
  await capture('artifact-01-native-history');
  await click('.transcript-artifact-open');
  await waitFrame('document.querySelector("#heading")?.textContent === "Saved report"', 'saved result without initial tool call');
  const retainedText = await inspect('document.querySelector("#retained").textContent');
  if (typeof retainedText !== 'string') throw new Error('Missing retained result text');
  const retained = JSON.parse(retainedText);
  if (JSON.stringify(retained) !== JSON.stringify({ title: 'Original report', calls: 1, retained: [3, 5, 8] })) throw new Error('Native structured result changed: ' + JSON.stringify(retained));
  assertNoReplay(); await capture('artifact-02-retained-result');
  await click('[aria-label="Close report result tab"]');
  await wait('document.querySelector(".mcp-app-frame") === null', 'original artifact closed');
  await click('.transcript-artifact-open'); await waitFrame('document.querySelector("#heading")?.textContent === "Saved report"', 'fresh deliberate artifact opens old result');
  assertNoReplay(); await capture('artifact-03-no-replay-reopen');
  await click('[aria-label="Close report result tab"]'); await wait('document.querySelector(".mcp-app-frame") === null', 'reopened artifact drained');
  await click('[aria-label="Toggle side panel"]'); await wait('panelState().actions.includes("Files")', 'empty panel reopened');
  await click('.dock-empty-panel-label', 'Files');
  await wait('document.querySelector("[role=treeitem][aria-label=\\"sample.report.note\\"]") !== null', 'real workspace file');
  await click('[role="treeitem"][aria-label="sample.report.note"]');
  await approveIfRequired(); await waitFrame('document.querySelector("#editor")?.value === "Original file note"', 'declared file viewer and original resource');
  const viewerTab = store.bootstrap().state!.dock!.tabs.find(tab => tab.mcpApp?.source?.type === 'file')!;
  if (!viewerTab) throw new Error('Missing persisted original file descriptor');
  await capture('artifact-04-original-file');
  await clickFrame('editor');
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] });
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
  await waitFrame('document.querySelector("#editor")?.selectionStart === 0 && document.querySelector("#editor")?.selectionEnd === document.querySelector("#editor")?.value.length', 'native editor selection');
  await window.webContents.debugger.sendCommand('Input.insertText', { text: 'Edited by original viewer' });
  await clickFrame('save'); await waitFrame('document.querySelector("#result")?.textContent === "saved"', 'revisioned actual filesystem save');
  if (readFileSync(join(flow.fixture, 'project/sample.report.note'), 'utf8') !== 'Edited by original viewer') throw new Error('Saved viewer bytes differ');
  await capture('artifact-05-saved');
  writeFileSync(join(flow.fixture, 'project/sample.report.note'), 'External change');
  await clickFrame('save'); await waitFrame('document.querySelector("#result")?.textContent === "conflict"', 'external edit conflict');
  if (readFileSync(join(flow.fixture, 'project/sample.report.note'), 'utf8') !== 'External change') throw new Error('Conflict overwrote external bytes');
  await capture('artifact-06-conflict');
  await clickFrame('refresh'); await waitFrame('document.querySelector("#editor")?.value === "External change"', 'deliberate refresh adopts current revision');
  await clickFrame('binary'); await waitFrame('document.querySelector("#result")?.textContent === "saved"', 'binary save');
  if (readFileSync(join(flow.fixture, 'project/sample.report.note')).toString('base64') !== 'AAH/') throw new Error('Binary save changed bytes');
  await clickFrame('refresh'); await waitFrame('document.querySelector("#editor")?.value === "Binary AAH/"', 'binary representation'); await capture('artifact-07-binary');
  await clickFrame('foreign'); await waitFrame('document.querySelector("#result")?.textContent.includes("could not be confirmed")', 'foreign resource rejected');
  if (providerCalls().some(value => value.method === 'resources/read' && String(value.params.uri).startsWith('codex-resource://'))) throw new Error('Original host resource escaped to MCP server');
  await capture('artifact-08-foreign-rejected');
  flow.setConnected(false); await wait('document.querySelector(".mcp-app-frame") === null && document.querySelector(".mcp-app-empty button")?.disabled', 'offline original document retired'); await capture('artifact-09-offline');
  flow.setConnected(true); await wait('document.querySelector(".mcp-app-empty button")?.disabled === false', 'deliberate recovery enabled');
  await click('.mcp-app-empty button', 'Open app'); await approveIfRequired(); await waitFrame('document.querySelector("#editor")?.value === "Binary AAH/"', 'same original file after reconnect');
  if (store.bootstrap().state!.dock!.tabs.find(tab => tab.mcpApp?.source?.type === 'file')?.id !== viewerTab.id) throw new Error('Recovery replaced saved original file identity');
  await capture('artifact-10-recovered');
  const documentId = await evaluate('panelState().documentId'); window.webContents.reload();
  await wait('typeof window.panelState === "function" && panelState().documentId !== ' + JSON.stringify(documentId), 'actual renderer reload');
  await wait('document.querySelector(".mcp-app-empty button")?.disabled === false', 'persisted viewer requires deliberate reopen');
  if (frame()) throw new Error('Restoration automatically ran viewer');
  await capture('artifact-11-restored');
  await click('.mcp-app-empty button', 'Open app'); await approveIfRequired(); await waitFrame('document.querySelector("#editor")?.value === "Binary AAH/"', 'original saved viewer restored');
  assertNoReplay(); await capture('artifact-12-restored-open');
  await click('[aria-label="Close sample.report.note tab"]'); await wait('!panelState().tabs.some(tab => tab.label.includes("sample.report.note"))', 'viewer close drains');
  await capture('artifact-13-closed');
}
