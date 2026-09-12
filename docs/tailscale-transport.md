# Existing Tailscale transport boundary

`apps/host/src/tailscale.ts` provides `TailscaleClient({ binaryPath?, timeoutMs? })`. It uses only the existing local CLI: `status --json` for presence and `whois --json <socket IP>` for identity. It never starts Tailscale, changes policy, configures Serve/Funnel, opens listeners or copies keys. Installed services can supply an explicit executable path; automatic lookup also supports Homebrew, Linux system paths and the macOS application executable.

`discover()` returns `TailscaleDiscovery`: backend state, current node, peers, MagicDNS suffix and observation time. Node metadata contains stable node/user IDs, display names, OS, direct Tailscale addresses, online/expired flags and tags. Every peer has `appAvailability: "unknown"`: an online Tailscale device is not evidence that this app is installed or running. Public keys, capabilities, login URLs, account profile fields and raw CLI errors are excluded.

`authorizePeer(remoteAddress, { allowedNodeIds? })` returns either `{ authorized: true, peer, checkedAt }` or a structured denial. It refreshes status and resolves the actual socket IP through the local Tailscale daemon. Authorization requires:

- The local node is running, online, unexpired and owned by a nonzero user identity.
- The address uniquely matches an online, unexpired direct peer address; loopback, local-self, routed subnet addresses and hostnames cannot authorize.
- The peer is untagged and owned by the same user as the local node. `whois` must agree on stable node ID, node user ID, profile user ID, direct host address and online status.
- If `allowedNodeIds` is supplied, the stable node ID must also be in that list. An empty list denies all peers. Pairing cannot bypass same-user ownership.

Numeric user IDs must fit safely in JavaScript or arrive as decimal strings. Unknown/malformed identity metadata, missing CLI, daemon failures and timeouts fail closed. Policy deliberately does not support tagged service identities or other-user device sharing in this milestone; the three selected machines are ordinary devices owned by the same user.

## Server integration

Keep the existing loopback bearer endpoint. For a remote endpoint, bind only to a current local Tailscale IP, take the address from the accepted socket (Bun's `server.requestIP(request).address`), and call `authorizePeer` before serving HTTP or upgrading WebSockets. Do not trust forwarded headers, claimed node IDs or DNS names. Reject browser `Origin` headers on both transports. Same-user Tailscale identity can authenticate the remote endpoint without copying the loopback bearer token. A reverse proxy changes the identity boundary and is not supported by this adapter.

The return value is a point-in-time authorization result, not a permanent grant. Revalidate long-lived connections when account/pairing policy changes and periodically while they remain connected; close denied peers. Discovery does not probe the app port or claim connectivity. The server still owns protocol checks, endpoint selection, app-host identity, request limits and lifecycle cleanup.

## Desktop connection controls

Settings → Connections exposes local access policy, discovery results and cached host catalog in Control this Mac and Control other devices views. Refresh uses the existing catalog refresh; Details projects known host/node metadata without changing a device. Use this machine navigates to an identified owning host, including its cached view when offline; it is not a persistent connection switch or an authorization grant.

An Available discovery result does not prove an authenticated owner connection. Device rows keep that distinction, while the profile-menu indicator uses the active owner's connection state. Machine switching remains available from the sidebar profile menu and the host control at the bottom of settings navigation.

The source now implements host-local availability and per-node revocation on `/v1/device-access`, administered only through the authenticated local listener. A successful change stores a new policy revision and requires host schema13; older hosts must refuse this database rather than ignore restrictions. Existing same-user access is preserved until an explicit change. Re-allowing a device removes its local restriction and never overrides Tailscale identity validation. Revocation denies subsequent requests and closes event streams; it does not cancel already-admitted work or move sessions.

The frozen Connections21 slice passed independent Standards and Spec review, with its controlled/native evidence limits preserved. No real tailnet grant/revocation or installed-device acceptance is claimed. SSH connection management and complete setup remain open; keep-awake passed its separate bounded implementation review, with controlled power evidence rather than real OS sleep-prevention proof.

## Evidence

On 2026-09-05, read-only CLI checks verified `Running` state and mutually visible online, untagged same-user nodes on `twaldin-home`, `twaldin@twaldin-work` and `tim@deckbox`. Both Macs run Tailscale 1.98.10; Deckbox runs 1.102.2. `whois` on home resolved work; `whois` on work and Deckbox resolved home's direct IP to the same stable node/user identity shown in their status. The production `TailscaleClient` running on home also discovered both selected peers and successfully authorized each through actual status/whois calls. These checks establish CLI identity discovery; they are not app installation, remote-listener or cross-device app acceptance evidence.

Deterministic tests invoke the production CLI adapter through temporary executable fixtures. They exercise metadata minimization, IPv4/IPv6 normalization, allowlists, wrong-user/tagged/offline/expired rejection, identity disagreement, subnet/hostname rejection, invalid JSON, unsafe IDs and timeout/failure handling. Fixtures do not count as live Tailscale evidence.

The upstream CLI warns its JSON shape may change. Relevant primary references: [CLI status and whois](https://tailscale.com/docs/reference/tailscale-cli), [1.98.10 status schema](https://github.com/tailscale/tailscale/blob/v1.98.10/ipn/ipnstate/ipnstate.go), [1.98.10 whois response](https://github.com/tailscale/tailscale/blob/v1.98.10/client/tailscale/apitype/apitype.go), and [stable IDs, direct addresses and expiry](https://github.com/tailscale/tailscale/blob/v1.98.10/tailcfg/tailcfg.go). Recheck these fields when upgrading either supported CLI version.
