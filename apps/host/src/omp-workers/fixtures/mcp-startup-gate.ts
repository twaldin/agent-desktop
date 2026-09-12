import { writeFile } from "node:fs/promises";
import path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
/** Actual native custom-tool factory runs after the SDK's initial MCP snapshot,
 * before it installs its live callback. Release the real stdio response here. */
export default async function () {
  const gates = process.env.MCP_CONTRACT_GATES;
  if (!gates) throw new Error("MCP startup control requires disposable gates.");
  const manager = MCPManager.instance();
  if (!manager) throw new Error("Native manager was not captured before custom-tool loading.");
  await writeFile(path.join(gates, "release-tools"), "");
  for (let index = 0; index < 500 && !manager.getTools().some(tool => tool.name === "mcp__fixture_tool"); index++) await Bun.sleep(10);
  const tools = manager.getTools().map(tool => tool.name);
  await writeFile(path.join(gates, "manager-before-session.json"), JSON.stringify(tools));
  if (!tools.includes("mcp__fixture_tool")) throw new Error("Real MCP tool list did not settle inside the native factory gate.");
  return [];
}
