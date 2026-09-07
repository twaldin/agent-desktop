# Agent-system integration after core app parity

Tim's September6 direction is to finish the OMP backend and faithful Codex frontend first, then add agent-system features in the same visual and interaction style. This is coordinated follow-on work, not a separate dashboard product or a replacement for the current milestone. No addon has been implemented or deployed by this plan.

Agent Desktop remains the control center. Desktop and a phone-friendly tailnet web entry should reuse host contracts and suitable components, icons and theme tokens. The reference-parity default remains intact. There must be no duplicate session, settings, terminal or scheduling backend.

Keep Codex's normal project/chat organization and New chat flow. Tim creates or refines Linear tickets by asking an ordinary project conversation; each worker remains a normal session paired with its ticket. Do not add custom system sidebar sections, separate worker/session navigation, a dashboard-first landing page, a chat-creation role selector, or Linear grouping that replaces projects. Appropriate additions are an optional Linear/ticket side-panel tab alongside the existing panels, a small native attention indicator, existing settings/usage surfaces, and at most one optional cross-project board/control-center page or modal. The eventual phone client uses the same identity and components.

The first addon delivery should show the three hosts, freshness/offline state, native session identities and supported opening paths, ticket-to-owner links, attention states, non-secret settings and provider/account usage. A discovered external session remains externally owned. Opening a row must not start a second owner, migrate its session or copy its worktree. Print-mode ticket owners currently have no attach channel; browser chat/terminals require an explicit supported owner transport and can follow separately.

## Existing seams and missing contracts

Reuse host discovery and identity binding in `apps/host/src/network.ts` and `apps/desktop/src/main/host-recovery.ts`; OMP settings/model validation and CAS in `apps/host/src/settings-http.ts`; account metadata in `apps/host/src/omp-accounts/`; and existing renderer components and tokens. Current source is ahead of installed17, so source capabilities are not deployed acceptance.

Add a host-local, allowlisted metadata projection and metadata-only event stream. Neither `/v1/state` nor `/v1/events` is suitable for a central projection: they include drafts or transcript-bearing runtime events. External ticket-owner OMP and any supported Codex discovery need explicit adapters with stable native identity, observed state/freshness and supported opening/control capabilities. The existing inactive-source import path does not establish live external-owner attachment.

Provider quota is separate from account login state and local token activity. It needs host adapters and stable opaque provider-account identities. Show a shared home/Deckbox allowance once, associated with both hosts; keep different reset windows separate. Missing quota is unavailable. Do not derive a remaining allowance from token totals or export credentials to identify accounts.

The privileged host API intentionally rejects browser Origin headers. A later web entry needs an explicit authenticated browser surface, Origin/CSRF checks and a verified Tailscale identity boundary. If served on Deckbox, its server may handle only the narrow projection and individually permitted operations; it cannot be an arbitrary proxy to host APIs. Do not remove the existing Origin rejection to make a web page work.

## Work data boundary

Tim permits work ticket titles/links, native session metadata and usage in the private cross-host view. Work code and secrets remain host-local. The projection excludes raw transcripts, drafts, diffs, terminal logs, tool output, auth material and key-bearing links before data leaves Work; logging and caches must enforce the same boundary. Settings require an explicit safe projection, not wholesale raw configuration. Browser content/control and desktop cache policy must satisfy this boundary before exposing Work content on another device.

## Ownership

This task owns Agent Desktop source: projection contracts, host discovery adapters, shared desktop/web UI and authentication, and usage presentation after the core milestone. The agent-system task owns ticket-runner/enrollment guidance, rollout, a host-local owner metadata producer, and baseline settings application/backup integration. Agree the producer schema before implementing either side. The producer should identify the ticket, host, harness/native session, observed state/freshness and attachment/opening capabilities without transferring work content.

Scope coordination stays with Tim's conversations and Linear. This integration must not introduce mechanical ticket-conflict arbitration, another dispatcher or automatic broadening of ticket intake. The agent-system task and the external UI verifier remain separate coordination partners; neither is authorized to overwrite this working tree or deploy over active sessions.

## Producer status semantics

Keep runtime phase, private lifecycle/stage, optional human attention, next scheduled check and observed freshness separate in the eventual agreed producer schema. A routine wait for a review quota or scheduled recheck has `attention: null`; it must not create a needs-Tim indicator. Human attention means a question, decision, authorization or action Tim must supply. The producer-side task supplied this distinction from its onboarding/review pilots; this app has not independently exercised that producer or implemented the addon. Core OMP/Codex parity remains first.
