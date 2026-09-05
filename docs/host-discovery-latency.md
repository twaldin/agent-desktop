# Host discovery latency

After Home's installed release 13 restart, its sidebar reported Work unavailable for several minutes while Work's desktop remained connected to Home. Work's owning service stayed at the same PID with one launchd run and unchanged data. Direct healthy responses took 441–5,212 ms; authenticated Work loopback itself reached 3,291 ms. Native authorization varied too, so the evidence does not attribute all delay to whois or the tailnet.

Discovery allowed only 1,500 ms for the complete health request. Source 14 permits 12 seconds: the native authorization path can perform two sequential Tailscale CLI calls, each bounded at five seconds, before returning an authenticated health response. Probes remain parallel and bounded. Authorization, its five-second cache, identity/protocol checks and redirect refusal are unchanged. Failed requests still mark the service unavailable; no cached identity grants access.

The production health-probe helper was tested against an actual Bun HTTP server delaying a valid response by 1,700 ms. The original deadline failed at 1,506 ms; the corrected helper succeeded at 1,705 ms. Fifteen focused network/auth tests passed with 68 assertions, including authorization/server errors, redirects, malformed identities and header/body deadlines. These controlled latency tests isolate the timeout defect; they do not reproduce the full physical machine's scheduling conditions.

Fresh physical probes and the actual Home sidebar recovered without a service restart before the source correction. The next installed release still needs physical observation under the new deadline. Release 13 remains installed; source changes alone do not establish its behavior.

Private evidence: `.data/network-health-source14/result.json`, `.data/ui-acceptance/release13-work-network-observation-{1,2}.json`, and `release13-work-network-latency.json`. The initial `-wrong-endpoint.json` retains useful direct health timing but its `/v1/network` 404 was a probe mistake; the actual local discovery route is `/v1/peers`.
