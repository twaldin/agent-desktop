# Owner image storage

`ImageAttachmentStore` stores original image bytes under the existing host data directory. It does not write OMP transcripts, credentials, provider configuration, draft names or attachment identities.

```ts
const images = new ImageAttachmentStore(dataDirectory);
const metadata = await images.putImage(expectedSha256, bytes);
const original = await images.readImage(metadata.sha256);
const verified = await images.readValidatedImage(metadata.sha256);
// verified = { metadata: { sha256, bytes, mimeType, width, height }, bytes }
```

Metadata is frozen. Each returned byte array belongs to its caller. Upload input is copied before the first asynchronous operation because `Bun.Image` borrows typed-array storage. Submission preparation must compare the captured reference's host, hash, byte count and MIME with owner-authoritative metadata before handing this byte snapshot to native OMP. No filesystem path crosses that boundary.

## Validation and limits

The shared attachment module owns the 20 MiB encoded-byte limit and PNG/JPEG/GIF/WebP allowlist. This store additionally rejects inputs over **16,777,216 pixels** before decode. That is an explicit initial application limit; larger native-supported images remain a parity gap. Batch admission (four images, 20 MiB total) belongs to the caller. The HTTP/preparation layer must bound concurrent upload/decode work too; this per-image bound alone does not bound the memory of arbitrarily many requests.

The pinned OMP 18.1.10 `parseImageMetadata` checks magic bytes. Pinned Bun 1.3.14 provides header-only metadata and a native `maxPixels` guard before allocating the source raster. A full native decode ending in a 1×1 PNG follows OMP's `imageDecodeFailureReason` strategy while retaining the original input bytes. A valid header alone is insufficient. The output resize does not bypass the source pixel limit. Bun's GIF contract decodes **the first frame**; this is not validation of every animation frame. Native normalization, animation fidelity and provider limits require their own acceptance.

Primary references: [Bun Image API](https://bun.com/docs/runtime/image), the installed `bun-types@1.3.14/bun.d.ts` Image constructor/metadata declarations, and `@oh-my-pi/pi-coding-agent@18.1.10/src/utils/image-loading.ts`. The web documentation can describe newer Bun versions; the focused native tests execute the pinned version's guard and decoder directly.

## Publication and recovery

Files live at `attachments/images/<first-two-digest-characters>/<sha256>`. Owned directories use mode 0700 and files use 0600. The configured host data directory must already exist as a real directory. Its trusted ancestor path may be canonicalized, including macOS `/var` → `/private/var`; the data directory itself and all owned storage components reject symlinks. Regular files, owner/mode checks, `O_NOFOLLOW`, open-file identity checks and before/after directory checks reject unsafe or detected changed paths. This is private application storage, not an OS sandbox against a hostile process running as the same account. The API accepts no renderer-chosen root or filename.

Publication writes and fsyncs a unique private temporary file, exclusively hard-links it to the digest, removes only that temporary link, then fsyncs the containing directory. Newly created ancestor directory entries are also synchronized. An existing digest is verified and preserved; even a correct retry cannot overwrite corrupt stored bytes. There is no metadata sidecar whose transaction could disagree with the blob, and no automatic garbage collection or deletion of abandoned uploads.

`AttachmentImageError` exposes a stable `code` and HTTP-style `status`. `IMAGE_DURABILITY_UNCERTAIN` (503) means complete bytes exist but synchronization could not be confirmed; no success receipt is returned and the bytes are retained. Retrying the same digest, or a successful `readValidatedImage`, verifies and synchronizes the file and directory entries before the caller may admit a reference. Reads use a size-bounded allocation, an extra-byte probe, file identity/revision checks, the full SHA-256 and native validation. Corruption fails closed instead of being silently repaired. Filesystem failures retain their underlying cause for host diagnostics.

## Focused evidence

Run `bun test apps/host/src/attachments/image-store.test.ts`. The isolated temporary-filesystem suite covers all four actual native formats, exact original bytes across reopen, independent input/read buffers, malformed compressed data with intact metadata, a valid oversized PNG header, the native predecode guard with 2×2 input and 1×1 output, concurrent publication from two store instances, corruption, symlink/non-regular/private-mode rejection, missing reads and actual write-permission refusal.

File and directory fsync failures are deliberately injected at the actual `FileHandle.sync` boundary; the remaining filesystem operations are real. These tests establish error classification, retained complete bytes and retry behavior, not physical power-loss durability. No provider call, live host directory or user image is involved. This foundation's first checkpoint was macOS arm64 on Bun 1.3.14; end-to-end native image prompts require separate evidence.

Deckbox Linux x64 also passed the exact production store suite (13 tests, 129 assertions), plus the shared attachment parser (3 tests, 26 assertions), using pinned Bun 1.3.14 and the installed OMP 18.1.10 dependency tree read-only. PNG/JPEG/GIF/WebP decode, the source-pixel guard, modes/paths, concurrent publication, corruption and both synchronization-failure contracts ran in an isolated temporary profile. All five transferred source hashes matched the working tree afterward; the test child exited and its temporary directory was removed. The existing managed host kept PID 1530607 throughout. Source hashes, runtime/dependency fingerprints, exact argv and output are preserved in `.data/attachment-linux-acceptance-8fd50e67-c234-475c-a045-b8b10c4d13c3/`. This was a source-level storage check; it did not install attachment support or perform provider inference on Linux.
