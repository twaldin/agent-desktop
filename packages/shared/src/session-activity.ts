export const SESSION_ACTIVITY_PROTOCOL_VERSION = 1;
export const SESSION_ACTIVITY_OWNER_HEADER = "X-Agent-Host-Id";

export type ActivityCapability<T> =
  | { availability: "available"; value: T }
  | { availability: "unavailable" | "unsupported"; reason: string };

export interface NativeGoalActivity {
  id: string;
  objective: string;
  status: "active" | "paused" | "budget-limited" | "complete" | "dropped";
  enabled: boolean;
  mode: "active" | "exiting";
  reason?: "completed";
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface NativeJobActivity {
  id: string;
  type: "bash" | "task" | "eval";
  status: "running" | "completed" | "failed" | "cancelled";
  label: string;
  startTime: number;
  agentId?: string;
}

export interface NativeJobActivitySnapshot {
  running: NativeJobActivity[];
  recent: NativeJobActivity[];
  delivery: { queued: number; delivering: boolean; nextRetryAt?: number; pendingJobIds: string[] };
}

export interface NativeAgentActivity {
  id: string;
  displayName: string;
  status: "running" | "idle" | "parked" | "aborted";
  parentId?: string;
  /** True only when the registry status is corroborated by a live streaming session. */
  running: boolean;
  createdAt: number;
  lastActivity: number;
  activity?: string;
}

export interface NativeSourceActivity {
  id: string;
  kind: string;
  label: string;
}

export interface NativeSessionActivity {
  goal: ActivityCapability<NativeGoalActivity | null>;
  jobs: ActivityCapability<NativeJobActivitySnapshot>;
  agents: ActivityCapability<NativeAgentActivity[]>;
  sources: ActivityCapability<NativeSourceActivity[]>;
}

export interface SessionActivitySnapshot extends NativeSessionActivity {
  protocolVersion: typeof SESSION_ACTIVITY_PROTOCOL_VERSION;
  hostId: string;
  sessionId: string;
}
