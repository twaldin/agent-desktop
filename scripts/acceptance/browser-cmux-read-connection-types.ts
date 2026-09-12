/** Check the actual public cmux declaration, including library checking, without importing the SDK. */
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

const selected = process.argv[2], output = process.argv[3];
if (!selected || !output) throw new Error("Pass the exact socket-client.d.ts and a new output directory.");
const declaration = realpathSync(selected), directory = path.resolve(output);
mkdirSync(directory);
const file = path.join(directory, "consumer.ts"), config = path.join(directory, "tsconfig.json");
writeFileSync(file, `import { CmuxSocketClient } from "selected-client";
declare const client: CmuxSocketClient;
const generation: number | undefined = client.connectionGeneration;
type IsAny<T> = 0 extends (1 & T) ? true : false;
const generationIsNotAny: IsAny<typeof client.connectionGeneration> = false;
// @ts-expect-error A caller cannot change connection identity.
client.connectionGeneration = 7;
if (generation !== undefined) {
 const response: Promise<Record<string, unknown>> = client.request("surface.list", {surface_id:"original"}, {connectionGeneration:generation,timeoutMs:5000});
 void response;
}
// @ts-expect-error Connection generations are numeric identities.
client.request("surface.list", {}, {connectionGeneration:"other"});
const ordinary: Promise<Record<string, unknown>> = client.request("browser.url.get", {});
void ordinary; void generationIsNotAny;
`);
writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, target: "ES2023", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2023"], types: [], paths: { "selected-client": [declaration] } }, files: [file] }, null, 2));
const command = [path.resolve("node_modules/.bin/tsc"), "-p", config, "--pretty", "false"];
const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
const log = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
writeFileSync(path.join(directory, "compiler.log"), log);
const hash = (name: string) => createHash("sha256").update(readFileSync(name)).digest("hex");
const record = { command, exitCode: result.exitCode, declaration, declarationSha256: hash(declaration), consumerSha256: hash(file), configSha256: hash(config), diagnostics: log, limits: "Public declaration and consumer only; no native source compilation, SDK import, installed package or socket execution." };
writeFileSync(path.join(directory, "result.json"), JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record));
process.exitCode = result.exitCode;
