# Maintained dependency patches

The package manifest and frozen Bun lockfile identify the patches used by a clean installation. Private source capsules and historical review packets are not installation inputs.

The OMP 18.1.10 patch was normalized for the first public release. Its 104 historical sections applied sequentially to the exact published archive; the resulting 55 changed files have identical contents and final modes in the current installer patch. The original cumulative patch remains in Git commit `b583fcb` and private immutable evidence.

Bun 1.3.14 has a [directory-mode bug when patches create nested files](https://github.com/oven-sh/bun/pull/33573). The installer encoding creates every new nested file with mode `100755`, followed by an explicit mode-only change to its intended `100644`. This lets Bun create searchable parent directories; the installed files end with their original intended permissions. Apply this paired encoding to later nested-file additions too. Do not remove those final mode changes or make the source files permanently executable.

A clean frozen Bun installation and a full byte/mode comparison against the intended package verified this encoding. When changing native code, regenerate the complete net patch against the pinned published archive and verify clean installation and final file modes. Do not append an unchecked sequence of overlapping patches. Preserve historical review freezes and distinguish installer encoding from behavioral source changes.
