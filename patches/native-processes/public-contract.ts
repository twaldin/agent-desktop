import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonObservedTarget, DaemonProcessOperation as DaemonOperation, DaemonProcessResult as DaemonRpcResult } from "@oh-my-pi/pi-coding-agent/launch/protocol";

declare const client: DaemonBrokerClient;
declare const target: DaemonObservedTarget;
declare const result: DaemonRpcResult;
void client.request({ op: "observe" });
void client.request({ op: "guarded", target, operation: { op: "stop", name: target.name, timeoutMs: 1000 } });
void client.request({ op: "guarded", target, operation: { op: "send", name: target.name, data: "input\n" } });
void client.request({ op: "guarded", target, operation: { op: "logs", name: target.name, lines: 100, head: false, follow: false, timeoutMs: 1000 } });
// @ts-expect-error Every guarded command requires the original observation.
const missingTarget: DaemonOperation = { op: "guarded", operation: { op: "restart", name: "process" } };
// @ts-expect-error A process target cannot grant broker-wide shutdown authority.
const globalCommand: DaemonOperation = { op: "guarded", target, operation: { op: "shutdown" } };
// @ts-expect-error A process target does not grant creation authority.
const creation: DaemonOperation = { op: "guarded", target, operation: { op: "start", spec: {} } };
// @ts-expect-error Generation must be a number, not an arbitrary transport key.
const badTarget: DaemonObservedTarget = { ...target, generation: "1" };
if (result.op === "observe") {
  const brokerId: string = result.brokerId;
  for (const row of result.daemons) {
    const processId: string = row.target.id;
    const generation: number = row.target.generation;
    void [brokerId, processId, generation, row.daemon.state];
  }
}
if (result.op === "guarded" && result.result.op === "logs") {
  const output: string = result.result.text;
  void output;
}
void [missingTarget, globalCommand, creation, badTarget];
