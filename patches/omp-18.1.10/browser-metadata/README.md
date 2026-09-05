# Owner-filtered browser metadata patch

This selected project patch targets pinned `@oh-my-pi/pi-coding-agent` 18.1.10, release commit `f241301c83726afe75a847e919b89977a54dafbe`. It adds one read-only export to the existing authoritative tab supervisor map:

```ts
listTabsForOwner(ownerSessionId): readonly OwnerTabMetadata[]
```

The export rejects an empty owner and filters exact creator ownership. It returns frozen copies of native `name`, `ownerSessionId`, `targetId`, `backend`, `kindTag`, `state`, and ready `url`/`title`/viewport only. It exposes no native browser handle, worker, CDP endpoint, profile path, pending operation, lifecycle subscription, or mutation.

Run `bun patches/omp-18.1.10/browser-metadata/run-isolated.ts` from this repository. The runner verifies Bun's pristine cached 18.1.10 package hash, copies that source into a private temporary directory, applies the patch with zero fuzz, and opens a real native OMP browser tab against a disposable local page. It verifies exact owner filtering, the actual native title/URL/target metadata, immutable snapshots, and rejection for another or empty owner. The selected workspace patch remains untouched.

The root `package.json` and `bun.lock` select the reproducible Bun patch at `patches/@oh-my-pi%2Fpi-coding-agent@18.1.10.patch`; host-worker and desktop metadata transport use this read-only seam. The runner does not alter that selection, start a host service, open an existing browser profile, invoke a provider, or create a browser panel. Polling this native export is sufficient for initial discovery; lifecycle subscription remains deferred.
