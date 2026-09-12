// Exercise the owned SDK in a fresh process without permitting inference traffic.
export {};
let fetchCalls = 0;
globalThis.fetch = Object.assign(async () => {
  fetchCalls++;
  throw new Error("Network access is disabled in the commit-generation contract.");
}, { preconnect: () => {} }) as typeof fetch;

const { generateGitCommitFromDiff } = await import("@oh-my-pi/pi-coding-agent/commit");
const input = await Bun.file(process.argv[2]!).json();
const request = { ...input };
const pending = generateGitCommitFromDiff(request);
// The selected owner and diff must be captured before Settings.init yields.
request.cwd = "/nonexistent-commit-contract-owner";
request.diff = input.diff.replaceAll("source.js", "mutated.js");
const result = await pending;
const abort = new AbortController();
abort.abort(new Error("contract-canceled"));
let aborted: string | undefined, empty: string | undefined;
try { await generateGitCommitFromDiff({ ...input, signal: abort.signal }); }
catch (error) { aborted = (error as Error).message; }
try { await generateGitCommitFromDiff({ ...input, diff: "" }); }
catch (error) { empty = (error as Error).message; }
process.stdout.write(JSON.stringify({ result, aborted, empty, fetchCalls }));
