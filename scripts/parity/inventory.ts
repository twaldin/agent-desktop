import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, join } from "node:path";

/** Build a private work ledger, not a parity score. Unlinked states stay pending.
 * Usage: bun scripts/parity/inventory.ts [bundle] [audit directory]
 * Audit inputs are arrays of findings in *.json; outputs use ledger.* names.
 */
const root = resolve(import.meta.dir, "../..");
const bundle = resolve(process.argv[2] ?? join(root, ".data/codex-screenshots"));
const output = resolve(process.argv[3] ?? join(root, ".data/parity-audit"));
for (const path of [bundle, output]) {
  const local = relative(join(root, ".data"), path);
  if (!local || local.startsWith("..") || local.startsWith("/")) throw new Error("Reference inputs and audit outputs must be inside the private .data directory.");
}
type Capture = { id: string; title: string; png: string; accessibility: string };
type Finding = { id: string; sections: string[]; referenceIds: string[]; classification: string; summary: string; currentEvidence: string[]; requiredBehavior: string; backendMapping: string; evidenceLevel: string; priority: string };
const inputs = new Map<string, string>();
async function json(path: string) {
  const bytes = await readFile(path);
  inputs.set(relative(root, path), createHash("sha256").update(bytes).digest("hex"));
  return JSON.parse(bytes.toString());
}
const manifest = await json(join(bundle, "manifest.json"));
const interactions = await json(join(bundle, "interaction-states.json"));
const geometry = await json(join(bundle, "geometry-report.json"));
const captures: Capture[] = manifest.captures;
const ids = new Set(captures.map(capture => capture.id));
if (ids.size !== captures.length) throw new Error("Reference capture IDs are not unique.");
await mkdir(output, { recursive: true, mode: 0o700 });
const findings: (Finding & { input: string })[] = [];
const sourceEvidence = new Map<string, { sha256: string; lines: number }>();
for (const name of (await readdir(output)).filter(name => name.endsWith(".json") && !name.startsWith("ledger.")).sort()) {
  const path = join(output, name), value = await json(path);
  if (!Array.isArray(value)) throw new Error(`Expected a findings array in ${name}. Keep other evidence in a subdirectory.`);
  for (const finding of value) {
    for (const key of ["id", "classification", "summary", "requiredBehavior", "backendMapping", "evidenceLevel", "priority"]) {
      if (typeof finding[key] !== "string" || !finding[key].trim()) throw new Error(`${name}: missing ${key}`);
    }
    for (const key of ["sections", "referenceIds", "currentEvidence"]) {
      if (!Array.isArray(finding[key]) || finding[key].some((item: unknown) => typeof item !== "string")) throw new Error(`${name}: invalid ${key}`);
    }
    for (const id of finding.referenceIds) if (!ids.has(id)) throw new Error(`${name}/${finding.id}: unknown capture ${id}; use exact manifest IDs.`);
    for (const location of finding.currentEvidence) {
      const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(location);
      if (!match) throw new Error(`${name}/${finding.id}: invalid source location ${location}`);
      const path = match[1]!;
      if (!sourceEvidence.has(path)) {
        const bytes = await readFile(resolve(root, path));
        sourceEvidence.set(path, { sha256: createHash("sha256").update(bytes).digest("hex"), lines: bytes.toString().trimEnd().split("\n").length });
      }
      const start = Number(match[2]), end = Number(match[3] ?? match[2]);
      if (start < 1 || end < start || end > sourceEvidence.get(path)!.lines) throw new Error(`${name}/${finding.id}: source range out of bounds: ${location}`);
    }
    if (findings.some(value => value.id === finding.id)) throw new Error(`Duplicate finding ID: ${finding.id}`);
    findings.push({ ...finding, input: name });
  }
}
const inventory = captures.map(capture => {
  const linked = findings.filter(finding => finding.referenceIds.includes(capture.id));
  return {
    ...capture,
    section: capture.id.split("/")[0],
    states: interactions.states.filter((state: { captureId: string }) => state.captureId === capture.id),
    findingIds: linked.map(finding => finding.id),
    sourceReview: linked.length ? "findings linked; remaining details unexamined" : "pending",
    visualComparison: "pending same-state candidate capture and comparison",
    // A source finding cannot pass pixels, transitions, backend execution or exclusions.
    verdict: "unverified",
  };
});
const transitions = interactions.transitions.map((transition: { captures: string[] }) => ({
  ...transition,
  findingIds: findings.filter(finding => transition.captures.some(id => finding.referenceIds.includes(id))).map(finding => finding.id),
  verification: "pending real UI execution; linked findings do not prove the transition",
}));
const sections = [...new Set(inventory.map(capture => capture.section))].sort().map(section => {
  const records = inventory.filter(capture => capture.section === section);
  return { section, captures: records.length, withLinkedFindings: records.filter(capture => capture.findingIds.length).length, pendingVisualComparison: records.length };
});
const ledger = {
  schemaVersion: 1, createdAt: new Date().toISOString(),
  sourceCommit: (await Bun.$`git -C ${root} rev-parse HEAD`.quiet().text()).trim(),
  sourceStatus: (await Bun.$`git -C ${root} status --porcelain`.quiet().text()).trim(),
  reference: { version: manifest.version, build: manifest.build, pinned: manifest.referenceBaseline, geometryFiles: geometry.files.length },
  inputs: Object.fromEntries(inputs),
  sourceEvidence: Object.fromEntries(sourceEvidence),
  limits: ["No current-app pixel or interaction pass is implied by this inventory.", "Capture bundle and pinned reference builds differ; retain that distinction.", "All records remain in the ledger, including captures containing excluded content. Exclusions require feature-specific GOAL reasoning, never whole-screen deletion.", "The bundle records known states, not every possible feature combination; uncaptured requirements stay open."],
  sections, findings, captures: inventory, transitions,
  uncapturedRequirements: interactions.requirements,
  userOriginals: interactions.userOriginals.map((original: object) => ({ ...original, verdict: "unverified; user original without controlled geometry" })),
};
await writeFile(join(output, "ledger.json"), JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
const link = (path: string) => relative(output, path).split("/").map(encodeURIComponent).join("/");
const escape = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const lines = ["# UI parity work ledger", "", `${captures.length} controlled captures; ${interactions.states.length} recorded interaction states; ${transitions.length} transitions; ${findings.length} source/reference findings. **No visual or interaction passes claimed.**`, "", "Every capture remains listed. A linked finding is evidence of a gap, not an exhaustive review of that capture. Compare each candidate through the project parity skill before closing work.", "", "## Surface inventory", "", "| Section | Captures | With linked findings | Pending visual comparison |", "| --- | ---: | ---: | ---: |", ...sections.map(section => `| ${section.section} | ${section.captures} | ${section.withLinkedFindings} | ${section.pendingVisualComparison} |`), "", "## Findings", ""];
for (const finding of findings) lines.push(`### ${finding.priority} · ${finding.id}`, "", finding.summary, "", `**${finding.classification}.** ${finding.evidenceLevel}.`, "", `Required: ${finding.requiredBehavior}`, "", `Backend: ${finding.backendMapping}`, "", `Source: ${finding.currentEvidence.map(escape).join(", ")}`, "", `Reference: ${finding.referenceIds.map(id => { const capture = captures.find(capture => capture.id === id)!; return `[${id}](${link(join(bundle, capture.png))})`; }).join(", ")}`, "");
lines.push("## Capture checklist", "", "| Capture | Source findings | Candidate comparison |", "| --- | --- | --- |");
for (const capture of inventory) lines.push(`| [${capture.id}](${link(join(bundle, capture.png))}) | ${capture.findingIds.join(", ") || "Pending"} | Pending |`);
lines.push("", "## Uncaptured requirements", "", "See ledger.json for the complete supplied frontier, transitions, original provenance and immutable input hashes. An unavailable reference does not remove the implementation requirement.", "");
await writeFile(join(output, "ledger.md"), lines.join("\n"), { mode: 0o600 });
console.log(JSON.stringify({ output: relative(root, output), captures: captures.length, states: interactions.states.length, transitions: transitions.length, findings: findings.length, verified: 0 }));
