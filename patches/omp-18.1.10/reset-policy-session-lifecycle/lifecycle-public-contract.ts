import type {
  CodexResetPolicySessionBinding,
  CodexResetPolicySessionLifecycleListener,
  CreateAgentSessionOptions,
} from "@oh-my-pi/pi-coding-agent";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Binding = Parameters<NonNullable<CreateAgentSessionOptions["codexResetPolicyOwnerFactory"]>>[0];
const exact: Equal<Binding, Readonly<CodexResetPolicySessionBinding>> = true;
const listener: CodexResetPolicySessionLifecycleListener = { beginClose() {}, drained() {} };
declare const binding: Binding;
const unsubscribe: () => void = binding.registerLifecycle(listener);
// @ts-expect-error Both lifecycle phases are required.
binding.registerLifecycle({ beginClose() {} });
void [exact, unsubscribe];
