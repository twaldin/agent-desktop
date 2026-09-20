#!/usr/bin/env python3
"""Regenerate the complete coding-agent patch with exact-session reset lifecycle."""

import argparse
import io
import re
import shutil
import subprocess
import tarfile
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("--published-git", type=Path, required=True)
parser.add_argument("--previous-patch", type=Path, required=True)
parser.add_argument("--authored-package", type=Path, required=True)
parser.add_argument("--work", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()

if args.work.exists():
	raise SystemExit(f"work path already exists: {args.work}")
args.work.mkdir(parents=True)

archive = subprocess.check_output(["git", "-C", str(args.published_git), "archive", "HEAD"])
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
	tar.extractall(args.work)

subprocess.run(["git", "init", str(args.work)], check=True, stdout=subprocess.DEVNULL)
subprocess.run(["git", "-C", str(args.work), "config", "user.name", "Validation"], check=True)
subprocess.run(["git", "-C", str(args.work), "config", "user.email", "validation@example.invalid"], check=True)
subprocess.run(["git", "-C", str(args.work), "add", "."], check=True)
subprocess.run(["git", "-C", str(args.work), "commit", "-m", "published"], check=True, stdout=subprocess.DEVNULL)
subprocess.run(["git", "-C", str(args.work), "apply", str(args.previous_patch.resolve())], check=True)

owned = [
	"src/session/agent-session-types.ts",
	"src/session/agent-session.ts",
	"src/sdk.ts",
	"dist/types/session/agent-session-types.d.ts",
	"dist/types/session/agent-session.d.ts",
]
for relative in owned:
	source = args.authored_package / relative
	if not source.is_file():
		raise SystemExit(f"missing authored source: {source}")
	shutil.copyfile(source, args.work / relative)

subprocess.run(["git", "-C", str(args.work), "add", "-A"], check=True)
patch = subprocess.check_output(
	["git", "-C", str(args.work), "diff", "--cached", "--binary", "--full-index"], text=True
)

paired = (Path(__file__).parent / "paired-files.txt").read_text().splitlines()
for relative in paired:
	marker = f"diff --git a/{relative} b/{relative}\n"
	start = patch.find(marker)
	if start < 0:
		raise SystemExit(f"missing paired path: {relative}")
	end = patch.find("diff --git ", start + len(marker))
	if end < 0:
		end = len(patch)
	section = patch[start:end]
	if "new file mode 100644\n" not in section:
		raise SystemExit(f"paired path is not new 100644: {relative}")
	patch = patch[:start] + section.replace("new file mode 100644\n", "new file mode 100755\n", 1) + patch[end:]

unpaired = re.findall(r"diff --git a/(.*?) b/.*?\nnew file mode 100644", patch)
if unpaired:
	raise SystemExit(f"unpaired new 100644 paths: {unpaired}")
patch += "".join(
	f"diff --git a/{relative} b/{relative}\nold mode 100755\nnew mode 100644\n" for relative in paired
)
args.output.write_text(patch)
