import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getDataDirectory(): string {
  if (process.env.AGENT_DESKTOP_DATA_DIR) return resolve(process.env.AGENT_DESKTOP_DATA_DIR);
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Agent Desktop")
    : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "agent-desktop");
}

export interface LocalConnection {
  origin: string;
  token: string;
  pid: number;
  hostId: string;
  protocolVersion: number;
}
