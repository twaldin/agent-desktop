import { expect, test } from "bun:test";
import { ApprovalRecovery } from "./approval-recovery";

test("an uncertain apply blocks replacement until ownership disposal completes", async () => {
  const recovery = new ApprovalRecovery();
  const disposal = Promise.withResolvers<void>();
  let forgotten = 0, admitted = 0;
  const retiring = recovery.retire("session", () => disposal.promise, () => forgotten++);
  const nextAdmission = recovery.wait("session").then(() => admitted++);
  await Promise.resolve(); await Promise.resolve();
  expect(forgotten).toBe(0); expect(admitted).toBe(0);
  await recovery.wait("another-session");
  disposal.resolve(); await retiring; await nextAdmission;
  expect(forgotten).toBe(1); expect(admitted).toBe(1);
});

test("disposal failure or timeout remains a barrier to every later prompt attempt", async () => {
  for (const failure of ["disposal failed", "worker termination deadline expired"]) {
    const recovery = new ApprovalRecovery();
    let forgotten = 0, disposalCalls = 0;
    const dispose = async () => { disposalCalls++; throw new Error(failure); };
    await expect(recovery.retire("session", dispose, () => forgotten++)).rejects.toThrow("blocked until host recovery");
    for (let attempt = 0; attempt < 3; attempt++) await expect(recovery.wait("session")).rejects.toThrow(failure);
    await expect(recovery.retire("session", dispose, () => forgotten++)).rejects.toThrow("blocked until host recovery");
    expect(forgotten).toBe(0); expect(disposalCalls).toBe(1);
  }
});
