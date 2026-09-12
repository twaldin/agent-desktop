"""Static check of exact worker browser callback and public Puppeteer boundary.

No SDK imports or JavaScript execution. The generated TypeScript is compiled only.
Whole worker files remain the source selections; extraction hashes and offsets
make this narrower contract explicit instead of claiming a full native compile.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
source = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=False)
raw = source.read_bytes()
text = raw.decode()
selections = []


def select(label, start, end, optional=False):
    if optional and start not in text:
        return ""
    assert text.count(start) == 1, label
    first = text.index(start)
    last = text.index(end, first) + len(end)
    value = text[first:last]
    selections.append({
        "label": label,
        "characterStart": first,
        "characterEnd": last,
        "byteStart": len(text[:first].encode()),
        "byteEnd": len(text[:last].encode()),
        "sha256": hashlib.sha256(value.encode()).hexdigest(),
    })
    return value


parser_import = select("parser DOM import", 'import type { HTMLElement }', ';', True)
ambient = select("global DOM augmentation", 'declare global {', '\n}', True)
realm = select("pinned public Frame augmentation", 'declare module "puppeteer-core" {', '\n}')
result = select("actionability result", 'type ActionabilityResult =', '\n')
callback = select("whole isClickActionable", 'async function isClickActionable(', '\n}')
fixture = '\n'.join([
    'import type { ElementHandle, Frame, Realm } from "puppeteer-core";',
    parser_import, ambient, realm, result, callback,
    # Real browser handles may contain HTML or SVG elements. Keep both accepted
    # by the unchanged evaluate API, without executing either callback.
    'declare const html: ElementHandle<HTMLButtonElement>;',
    'declare const svg: ElementHandle<SVGElement>;',
    'const htmlResult: Promise<ActionabilityResult> = isClickActionable(html);',
    'const svgResult: Promise<ActionabilityResult> = isClickActionable(svg);',
    'declare const frame: Frame;',
    'const realm: Realm = frame.mainRealm();',
    'const documentType: Document = globalThis.document;',
    'void [htmlResult, svgResult, realm, documentType];',
]) + '\n'
(output / 'callback.ts').write_text(fixture)
puppeteer = root / 'node_modules/.bun/puppeteer-core@25.3.0/node_modules/puppeteer-core'
config = {
    "compilerOptions": {
        "strict": True, "skipLibCheck": False, "noEmit": True,
        "target": "ESNext", "module": "ESNext", "moduleResolution": "Bundler",
        "types": ["node"], "lib": ["ESNext", "DOM"],
        "paths": {"puppeteer-core": [str(puppeteer)]},
    },
    "files": [str(output / 'callback.ts')],
}
(output / 'tsconfig.json').write_text(json.dumps(config, indent=2) + '\n')
command = [str(root / 'node_modules/.bin/tsc'), '-p', str(output / 'tsconfig.json'), '--pretty', 'false']
run = subprocess.run(command, cwd=root, capture_output=True, text=True)
(output / 'compiler.log').write_text(run.stdout + run.stderr)
evidence = {
    "source": str(source), "sourceSha256": hashlib.sha256(raw).hexdigest(),
    "sourceUnchanged": source.read_bytes() == raw,
    "selections": selections,
    "fixtureSha256": hashlib.sha256(fixture.encode()).hexdigest(),
    "command": command, "exitCode": run.returncode,
    "boundary": "Extracted actual callback and public type contract only; no full worker/native compile or evaluation.",
}
(output / 'result.json').write_text(json.dumps(evidence, indent=2) + '\n')
print(json.dumps(evidence))
print(run.stdout + run.stderr)
sys.exit(run.returncode or (0 if evidence['sourceUnchanged'] else 1))
