import { createRoot } from "react-dom/client";
import { GoalPanel } from "../../apps/desktop/src/renderer/GoalPanel";
import { GoalStrip } from "../../apps/desktop/src/renderer/GoalStrip";
import { TranscriptItem } from "../../apps/desktop/src/renderer/Transcript";
import { TranscriptDisclosureState } from "../../apps/desktop/src/renderer/transcript-state";
import { useSessionActivity } from "../../apps/desktop/src/renderer/use-session-activity";
import type {
  DesktopBridge,
  GoalMutationRequest,
  SessionActivitySnapshot,
} from "../../packages/shared/src/protocol";
import "../../apps/desktop/src/renderer/styles.css";

const mount = createRoot(document.getElementById("root")!);
const checks: string[] = [];
const requests: GoalMutationRequest[] = [];
const listeners = new Set<(event: any) => void>();
const fingerprint = "a".repeat(64);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const assert = (value: unknown, message: string): asserts value => {
  if (!value) throw new Error(message);
};
async function wait(check: () => unknown, description: string) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error(`Timed out: ${description}`);
}
const goal = (objective = "Ship the native goal panel", updatedAt = 20) => ({
  id: "goal-1",
  objective,
  status: "active" as const,
  enabled: true,
  mode: "active" as const,
  tokensUsed: 30,
  timeUsedSeconds: 12,
  createdAt: 10,
  updatedAt,
});
const snapshot = (
  hostId = "host-a",
  sessionId = "session-a",
  objective?: string,
  updatedAt?: number,
): SessionActivitySnapshot => ({
  protocolVersion: 1,
  hostId,
  sessionId,
  goal: { availability: "available", value: goal(objective, updatedAt) },
  jobs: {
    availability: "available",
    value: {
      running: [],
      recent: [],
      delivery: { queued: 0, delivering: false, pendingJobIds: [] },
    },
  },
  agents: { availability: "available", value: [] },
  sources: { availability: "available", value: [] },
  goalControlTicket: {
    controlEpoch: "epoch-1",
    observedAt: 100,
    goalFingerprint: fingerprint,
  },
});
let reads: Array<() => Promise<SessionActivitySnapshot | null>> = [];
let mutationOutcome: "completed" | "rejected" | "unknown" = "completed";
const bridge: DesktopBridge = {
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSessionActivity: async (sessionId, hostId) => {
    const read = reads.shift();
    return read ? read() : snapshot(hostId ?? "host-a", sessionId);
  },
  mutateGoal: async (sessionId, request, hostId) => {
    requests.push(request);
    if (mutationOutcome === "completed")
      return {
        protocolVersion: 1,
        hostId: hostId!,
        sessionId,
        requestId: request.requestId,
        outcome: "completed",
        goal: request.mutation.type === "drop" ? null : goal(),
      };
    return {
      protocolVersion: 1,
      hostId: hostId!,
      sessionId,
      requestId: request.requestId,
      outcome: mutationOutcome,
      message:
        mutationOutcome === "unknown"
          ? "Native acknowledgement was lost."
          : "The goal changed on the owning host.",
    };
  },
} as DesktopBridge;
function ActivityProbe({
  hostId,
  sessionId,
}: {
  hostId: string;
  sessionId: string;
}) {
  const activity = useSessionActivity(
    bridge,
    hostId,
    sessionId,
    true,
    true,
    "host-a",
  );
  return (
    <output data-owner={activity.owner} data-error={activity.error ?? ""}>
      {activity.value?.goal.availability === "available"
        ? (activity.value.goal.value?.objective ?? "none")
        : "loading"}
    </output>
  );
}
const event = (hostId: string, sessionId: string) =>
  listeners.forEach((listener) =>
    listener({
      type: "runtime",
      hostId,
      sessionId,
      event: { activityChanged: true },
    }),
  );
const panelActivity = (value: SessionActivitySnapshot) => ({
  owner: `${value.hostId}:${value.sessionId}`,
  value,
  refresh: () => {
    refreshes++;
  },
});
let refreshes = 0;
let edits = 0;
function change(input: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
Object.assign(window, {
  goalPanelProgress: () => ({
    checks,
    requests: requests.map((request) => ({
      mutation: request.mutation,
      expectedGoal: request.expectedGoal,
      controlEpoch: request.controlEpoch,
      observedAt: request.observedAt,
      goalFingerprint: request.goalFingerprint,
    })),
    text: document.body.innerText,
  }),
  goalPanelStart: async () => {
    let resolveOld!: (value: SessionActivitySnapshot) => void;
    reads = [
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      async () => snapshot("host-b", "session-b", "New owner goal"),
    ];
    mount.render(<ActivityProbe hostId="host-a" sessionId="session-a" />);
    await sleep(30);
    mount.render(<ActivityProbe hostId="host-b" sessionId="session-b" />);
    await wait(
      () => document.querySelector("output")?.textContent === "New owner goal",
      "new owner activity",
    );
    resolveOld(snapshot("host-a", "session-a", "Late owner goal"));
    await sleep(80);
    assert(
      document.querySelector("output")?.textContent === "New owner goal",
      "late owner response replaced selected activity",
    );
    checks.push(
      "owner switch synchronously excludes a late prior-owner activity response",
    );

    let failed = false;
    reads = [
      async () => {
        failed = true;
        throw new Error("Owning host temporarily unavailable");
      },
      async () => snapshot("host-b", "session-b", "Recovered goal"),
    ];
    mount.render(
      <ActivityProbe key="recovery" hostId="host-b" sessionId="session-b" />,
    );
    await wait(
      () =>
        document
          .querySelector("output")
          ?.dataset.error.includes("temporarily unavailable"),
      "activity error",
    );
    event("host-a", "session-b");
    await sleep(130);
    assert(
      failed &&
        document
          .querySelector("output")
          ?.dataset.error.includes("temporarily unavailable"),
      "foreign owner event refreshed selected activity",
    );
    event("host-b", "session-b");
    await wait(
      () => document.querySelector("output")?.textContent === "Recovered goal",
      "matching activity event recovery",
    );
    assert(
      !document.querySelector("output")?.dataset.error,
      "activity error remained after recovered owner response",
    );
    reads = [
      async () => {
        throw new Error("temporary refresh failure");
      },
      async () => snapshot("host-b", "session-b", "Fresh activity"),
    ];
    event("host-b", "session-b");
    await wait(
      () =>
        document
          .querySelector("output")
          ?.dataset.error.includes("temporary refresh failure"),
      "stale activity error",
    );
    assert(
      document.querySelector("output")?.textContent === "Recovered goal",
      "activity error discarded the last selected snapshot",
    );
    event("host-b", "session-b");
    await wait(
      () => document.querySelector("output")?.textContent === "Fresh activity",
      "stale activity recovery",
    );
    checks.push(
      "selected activity keeps polling while no Environment surface is mounted; matching events recover errors without discarding stale owner data and foreign owners are ignored",
    );

    const activeClock = {
      ...snapshot(),
      goal: {
        availability: "available" as const,
        value: { ...goal(), tokensUsed: 4, timeUsedSeconds: 0 },
      },
    };
    mount.render(
      <GoalStrip
        bridge={bridge}
        hostId="host-a"
        sessionId="session-a"
        snapshot={activeClock}
        running={true}
        archived={false}
        refresh={() => undefined}
        onEdit={() => undefined}
      />,
    );
    await wait(
      () => document.querySelector(".goal-usage")?.textContent === "0s",
      "initial active elapsed",
    );
    await wait(
      () => document.querySelector(".goal-usage")?.textContent === "1s",
      "client-anchored active elapsed tick",
    );
    const nextOwnerClock = {
      ...activeClock,
      hostId: "host-b",
      sessionId: "session-b",
    };
    mount.render(
      <GoalStrip
        bridge={bridge}
        hostId="host-b"
        sessionId="session-b"
        snapshot={nextOwnerClock}
        running={true}
        archived={false}
        refresh={() => undefined}
        onEdit={() => undefined}
      />,
    );
    await wait(
      () => document.querySelector(".goal-usage")?.textContent === "0s",
      "owner-specific elapsed receipt base",
    );
    const pausedClock = {
      ...nextOwnerClock,
      goal: {
        availability: "available" as const,
        value: {
          ...nextOwnerClock.goal.value!,
          status: "paused" as const,
          timeUsedSeconds: 5,
        },
      },
    };
    mount.render(
      <GoalStrip
        bridge={bridge}
        hostId="host-b"
        sessionId="session-b"
        snapshot={pausedClock}
        running={true}
        archived={false}
        refresh={() => undefined}
        onEdit={() => undefined}
      />,
    );
    await sleep(1_100);
    assert(
      document.querySelector(".goal-usage")?.textContent === "5s",
      "paused goal advanced beyond its native elapsed figure",
    );
    const offlineClock = {
      ...nextOwnerClock,
      goal: {
        availability: "available" as const,
        value: { ...nextOwnerClock.goal.value!, timeUsedSeconds: 7 },
      },
    };
    mount.render(
      <GoalStrip
        bridge={bridge}
        hostId="host-b"
        sessionId="session-b"
        snapshot={offlineClock}
        stale="Owning host is offline."
        running={true}
        archived={false}
        refresh={() => undefined}
        onEdit={() => undefined}
      />,
    );
    await sleep(1_100);
    assert(
      document.querySelector(".goal-usage")?.textContent === "7s",
      "offline goal advanced beyond its native elapsed figure",
    );
    checks.push(
      "active no-budget elapsed advances from the local receipt clock, while paused or offline strips stay at native time and owner changes reset the receipt base",
    );

    const active = snapshot();
    mutationOutcome = "completed";
    mount.render(
      <GoalStrip
        bridge={bridge}
        hostId="host-a"
        sessionId="session-a"
        snapshot={active}
        running={true}
        archived={false}
        refresh={() => {
          refreshes++;
        }}
        onEdit={() => {
          edits++;
        }}
      />,
    );
    await wait(
      () => document.querySelector(".goal-usage")?.textContent === "12s",
      "restored active goal strip",
    );
    await wait(
      () =>
        document.querySelector<HTMLButtonElement>(
          '[aria-label="Pause goal"]',
        ) !== null,
      "goal strip",
    );
    document
      .querySelector<HTMLButtonElement>('[aria-label="Pause goal"]')!
      .click();
    await wait(
      () => requests.at(-1)?.mutation.type === "pause",
      "pause mutation",
    );
    await wait(
      () =>
        document.querySelector(".goal-strip")?.getAttribute("aria-busy") ===
        "false",
      "pause completion",
    );
    document
      .querySelector<HTMLButtonElement>('[aria-label="Clear goal"]')!
      .click();
    await wait(
      () => requests.at(-1)?.mutation.type === "drop",
      "drop mutation",
    );
    assert(
      refreshes >= 2,
      "completed strip mutations did not refresh activity",
    );
    document
      .querySelector<HTMLButtonElement>('[aria-label="Edit goal"]')!
      .click();
    assert(edits === 1, "goal strip edit did not open its editor callback");
    checks.push(
      "running goal strip sends owner-bound pause and drop mutations and opens the editor through real controls",
    );

    const disclosures = new TranscriptDisclosureState();
    mount.render(
      <TranscriptItem
        message={{
          id: "assistant-completed-goal",
          nativeId: "native-assistant-completed-goal",
          role: "assistant",
          text: "The native goal is complete.",
          lifecycle: "complete",
          goalCompletion: {
            entryId: "goal-completed-native-entry",
            objective: "Ship the native goal panel",
            tokensUsed: 42,
            tokenBudget: 100,
            timeUsedSeconds: 9,
          },
        }}
        connected
        disclosures={disclosures}
        calls={new Map()}
      />,
    );
    await wait(
      () => document.querySelector(".transcript-goal-achievement"),
      "goal achievement footer",
    );
    const achievement = document.querySelector<HTMLElement>(
      ".transcript-goal-achievement",
    )!;
    assert(
      achievement.textContent === "Goal achieved in 9s" &&
        achievement.title ===
          "42 tokens used / 100 token budget · 9s active time" &&
        achievement.querySelector('svg[viewBox="0 0 16 16"]'),
      "native completion did not render the bounded goal footer and tooltip",
    );
    mount.render(
      <TranscriptItem
        message={{
          id: "assistant-without-completion",
          role: "assistant",
          text: "An ordinary completed assistant response.",
          lifecycle: "complete",
        }}
        connected
        disclosures={disclosures}
        calls={new Map()}
      />,
    );
    await sleep(20);
    assert(
      !document.querySelector(".transcript-goal-achievement"),
      "ordinary assistant completion rendered a fabricated goal footer",
    );
    checks.push(
      "only a native goal-completed attachment adds the subdued assistant footer with exact duration and native token figures",
    );

    const activity = panelActivity(active);
    mutationOutcome = "rejected";
    mount.render(
      <GoalPanel
        bridge={bridge}
        hostId="host-a"
        sessionId="session-a"
        connected
        running={false}
        archived={false}
        active
        activity={activity}
      />,
    );
    await wait(
      () => document.querySelector<HTMLTextAreaElement>('[aria-label="Goal"]'),
      "goal editor",
    );
    const editor = document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Goal"]',
    )!;
    change(editor, "Keep this local edit");
    await wait(
      () => !document.querySelector<HTMLButtonElement>(".goal-save")!.disabled,
      "dirty editor save",
    );
    document.querySelector<HTMLButtonElement>(".goal-save")!.click();
    await wait(
      () => document.body.innerText.includes("goal changed on the owning host"),
      "rejected remote edit",
    );
    const rejected = requests.at(-1)!;
    assert(
      editor.value === "Keep this local edit",
      "rejected remote edit discarded the local text",
    );
    assert(
      rejected.expectedGoal?.id === "goal-1" &&
        rejected.expectedGoal?.updatedAt === 20 &&
        rejected.goalFingerprint === fingerprint &&
        rejected.controlEpoch === "epoch-1" &&
        rejected.observedAt === 100,
      "editor save did not hold its base goal fingerprint and current control ticket",
    );
    checks.push(
      "editor save holds the opening base revision/fingerprint and preserves typed text after remote rejection",
    );

    mutationOutcome = "unknown";
    document.querySelector<HTMLButtonElement>(".goal-save")!.click();
    await wait(
      () => document.body.innerText.includes("acknowledgement was lost"),
      "unknown edit outcome",
    );
    const before = requests.length;
    await sleep(300);
    assert(
      requests.length === before,
      "unknown goal edit retried automatically",
    );
    assert(
      editor.value === "Keep this local edit",
      "unknown goal edit lost typed text",
    );
    checks.push(
      "unknown goal edit outcome is surfaced, preserved locally, and never replayed",
    );
    return { passed: true, checks, requests: requests.length };
  },
  goalPanelGeometry: async () => {
    await document.fonts.ready;
    await sleep(60);
    const element = document.querySelector<HTMLElement>(
      ".goal-panel, .goal-region",
    );
    const rect = element?.getBoundingClientRect();
    return {
      rect: rect?.toJSON(),
      fitting: Boolean(
        rect &&
        rect.left >= -1 &&
        rect.right <= innerWidth + 1 &&
        rect.bottom <= innerHeight + 1 &&
        document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      fixtureSupported: true,
    };
  },
});
