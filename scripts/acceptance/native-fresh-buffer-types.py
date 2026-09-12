"""Compile exact allocating helpers and backing-buffer contracts; never execute them."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--native-root', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
native = args.native_root.resolve()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
wire = root / 'node_modules/.bun/@oh-my-pi+pi-wire@18.1.10/node_modules/@oh-my-pi/pi-wire/src/index.ts'
protocol = native / 'src/collab/protocol.ts'
objects = native / 'src/blob-broker/uploaders-object-storage.ts'
inputs = [protocol, objects, wire, Path(__file__).resolve(), root / 'node_modules/.bin/tsc']
sha = lambda data: hashlib.sha256(data).hexdigest()
before = {str(p): sha(p.read_bytes()) for p in inputs}
windows = []

def select(path, text):
    data = path.read_bytes()
    selected = text.encode()
    assert data.count(selected) == 1
    start = data.index(selected)
    windows.append({'source': str(path), 'sourceSha256': sha(data), 'byteStart': start,
                    'byteEnd': start + len(selected), 'sha256': sha(selected)})
    return text

def function(path, name):
    text = path.read_text()
    match = re.search(r'^(?:export )?function ' + re.escape(name) + r'\(', text, re.M)
    assert match is not None
    end = text.index('\n}', match.start()) + 2
    return select(path, text[match.start():end])

constant = re.search(r'^export const ENVELOPE_HEADER_LENGTH = \d+;', wire.read_text(), re.M)
assert constant is not None
source = '\n\n'.join([select(wire, constant.group()), function(protocol, 'packEnvelope'),
                       function(protocol, 'unpackEnvelope'), function(objects, 'concatenate')])
source += '''
// Compiled only: shared-backed inputs remain supported by both allocating helpers.
declare const shared: Uint8Array<SharedArrayBuffer>;
const packed = packEnvelope(1, shared.subarray(1, 3));
const packedBuffer: ArrayBuffer = packed.buffer;
const joined = concatenate([shared.subarray(1, 3), new Uint8Array(2)]);
const joinedBuffer: ArrayBuffer = joined.buffer;
const unpacked = unpackEnvelope(shared);
if (unpacked) {
  // @ts-expect-error a view of arbitrary input must not claim ordinary backing
  const notProvedOrdinary: ArrayBuffer = unpacked.payload.buffer;
  void notProvedOrdinary;
}
// @ts-expect-error the precise output contract must reject shared storage
const invalidOrdinary: Uint8Array<ArrayBuffer> = shared;
void [packedBuffer, joinedBuffer, invalidOrdinary];
'''
consumer = output / 'consumer.ts'
consumer.write_text(source)
config = output / 'tsconfig.json'
config.write_text(json.dumps({'compilerOptions': {'target': 'ESNext', 'module': 'ESNext',
    'strict': True, 'skipLibCheck': False, 'noEmit': True, 'types': [], 'lib': ['ESNext', 'DOM']},
    'files': [str(consumer)]}, indent=2) + '\n')
command = [str(root / 'node_modules/.bin/tsc'), '-p', str(config), '--pretty', 'false']
generated_before = {str(p): sha(p.read_bytes()) for p in [consumer, config]}
run = subprocess.run(command, cwd=root, capture_output=True, text=True)
generated_after = {str(p): sha(p.read_bytes()) for p in [consumer, config]}
(output / 'compiler.log').write_text(run.stdout + run.stderr)
after = {str(p): sha(p.read_bytes()) for p in inputs}
result = {'command': command, 'exitCode': run.returncode, 'before': before, 'after': after,
          'stable': before == after and generated_before == generated_after, 'windows': windows,
          'generatedBefore': generated_before, 'generatedAfter': generated_after,
          'consumerSha256': sha(consumer.read_bytes()), 'configSha256': sha(config.read_bytes()),
          'limits': 'Exact selected helper bodies, not whole modules. Generated inputs fenced before/after compilation; compiler libraries not fully fenced. No runtime/SDK evaluation.'}
(output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'exitCode': run.returncode, 'stable': result['stable'], 'windows': len(windows)}))
raise SystemExit(run.returncode)
