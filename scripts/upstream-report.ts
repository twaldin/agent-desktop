import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asarRows, codexMetadataRows, exists, fileEvidence, metadata, packageRoot, readJson, sha256, sourcePath, type JsonArtifact } from "./upstream-artifacts";
import { capabilityRows, canonical, compareRows, list, object, settingRows, string, themeRows, visualRows, type Check, type Evidence, type InventoryRow } from "./upstream-inventory";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const CODEX_BASELINE = ".reference/codex-26.901.41600";
const OMP_BASELINE = ".reference/omp-18.1.10-release";
const BUN_BASELINE = "1.3.14";
export interface ReportOptions { repository?: string; codexApp?: string; codexCandidate?: string; ompCandidateInventory?: string; ompCandidatePackage?: string; generatedAt?: string }
export interface UpstreamReport {
  format: 1; generatedAt: string; purpose: string; checks: Check[];
  summary: { unchanged: number; changed: number; unknown: number; invalid: number; observedDrift: boolean; exitCode: 0 | 1 | 2 };
  limits: string[];
}
function unknown(id: string, title: string, detail: string, sources: Evidence[] = []): Check { return { id, title, status: "unknown", details: [detail], sources }; }
function scalarCheck(id: string, title: string, before: unknown, after: unknown, sources: Evidence[], details: string[] = []): Check {
  return { id, title, before, after, status: canonical(before) === canonical(after) ? "unchanged" : "changed", sources, details };
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function buildReport(options: ReportOptions = {}): Promise<UpstreamReport> {
  const repository = resolve(options.repository ?? REPOSITORY), codexBaseline = join(repository, CODEX_BASELINE), ompBaseline = join(repository, OMP_BASELINE);
  const checks: Check[] = [];
  async function check(id: string, title: string, fn: () => Promise<Check>, missingIsUnknown = false): Promise<Check> {
    let value: Check;
    try { value = await fn(); }
    catch (error) { value = { id, title, status: missingIsUnknown && (error as NodeJS.ErrnoException).code === "ENOENT" ? "unknown" : "invalid", details: [errorText(error)], sources: [] }; }
    checks.push(value); return value;
  }
  const baselineMetadata = await readJson(join(codexBaseline, "reference-metadata.json"));
  const baselineArchive = await check("codex.baseline-integrity", "Preserved Codex archive integrity", async () => {
    const artifact = await fileEvidence(join(codexBaseline, "app.asar"));
    const result = scalarCheck("codex.baseline-integrity", "Preserved Codex archive integrity", baselineMetadata.value.appAsarSha256, artifact.sha256, [baselineMetadata.evidence, artifact]);
    if (result.status === "changed") { result.status = "invalid"; result.details.push("Preserved archive no longer matches the accepted baseline hash; do not trust downstream agreement."); }
    return result;
  });
  async function compareCodex(label: string, directory: string, isBundle: boolean, optional = false) {
    const metaPath = join(directory, isBundle ? "Contents/Info.plist" : "reference-metadata.json");
    const archivePath = join(directory, isBundle ? "Contents/Resources/app.asar" : "app.asar");
    let observedMetadata: JsonArtifact | undefined;
    await check(`codex.${label}.metadata`, `Codex ${label} metadata`, async () => {
      const artifact = await metadata(metaPath);
      observedMetadata = artifact;
      return compareRows(`codex.${label}.metadata`, `Codex ${label} metadata`, codexMetadataRows(baselineMetadata), codexMetadataRows(artifact), [baselineMetadata.evidence, artifact.evidence]);
    }, optional || !isBundle);
    const archive = await check(`codex.${label}.archive`, `Codex ${label} archive bytes`, async () => {
      if (baselineArchive.status === "invalid") return unknown(`codex.${label}.archive`, `Codex ${label} archive bytes`, "Baseline integrity failed.");
      const artifact = await fileEvidence(archivePath);
      return scalarCheck(`codex.${label}.archive`, `Codex ${label} archive bytes`, baselineMetadata.value.appAsarSha256, artifact.sha256, [baselineMetadata.evidence, artifact], ["Whole app.asar SHA-256 only; equality does not establish UI parity, current feature flags or native framework equality."]);
    }, optional || !isBundle);
    await check(`codex.${label}.resources`, `Codex ${label} resource header`, async () => {
      if (!["unchanged", "changed"].includes(archive.status)) return unknown(`codex.${label}.resources`, `Codex ${label} resource header`, "Archive unavailable or baseline invalid.", archive.sources);
      return compareRows(`codex.${label}.resources`, `Codex ${label} resource header`, await asarRows(join(codexBaseline, "app.asar")), await asarRows(archivePath), archive.sources,
        ["Exact resource paths and header fields. Content-hashed filename changes appear as additions/removals. Declared member integrity is not independently verified; unpacked resources are outside app.asar."]);
    });
    for (const [filename, parse, title] of [
      ["visual-token-inventory.json", visualRows, "CSS tokens, fonts and cascade declarations"], ["theme-defaults.json", themeRows, "Shipped appearance settings and defaults"],
    ] as const) {
      await check(`codex.${label}.${filename}`, `Codex ${label}: ${title}`, async () => {
        const baseline = await readJson(join(codexBaseline, filename));
        if (isBundle || !await exists(join(directory, filename))) {
          return unknown(`codex.${label}.${filename}`, `Codex ${label}: ${title}`, archive.status === "unchanged"
            ? "Archive bytes match. Preserved declarations remain the reference; no new extraction, resolved CSS or live behavior verification was performed. Supply an explicit candidate inventory to compare descriptors."
            : "No candidate static inventory supplied. Archive drift cannot determine semantic visual/default changes.", [baseline.evidence, ...archive.sources]);
        }
        const candidate = await readJson(join(directory, filename));
        if (observedMetadata && candidate.value.reference_version !== observedMetadata.value.CFBundleShortVersionString) throw new Error(`Candidate inventory/metadata version mismatch: ${filename}`);
        if (observedMetadata && candidate.value.reference_build !== undefined && candidate.value.reference_build !== observedMetadata.value.CFBundleVersion) throw new Error(`Candidate inventory/metadata build mismatch: ${filename}`);
        return compareRows(`codex.${label}.${filename}`, `Codex ${label}: ${title}`, parse(baseline.value, baseline.evidence), parse(candidate.value, candidate.evidence), [baseline.evidence, candidate.evidence],
          ["Supplied inventory declarations compared as data; not re-extracted or authenticated against candidate code. CSS source filenames, declaration order and selector ancestry remain significant. Values are not computed styles."]);
      });
    }
  }
  await compareCodex("installed", resolve(options.codexApp ?? "/Applications/ChatGPT.app"), true, !options.codexApp);
  if (options.codexCandidate) {
    const candidate = resolve(options.codexCandidate);
    if (!await exists(candidate)) throw new Error(`Codex candidate directory does not exist: ${candidate}`);
    await compareCodex("candidate", candidate, await exists(join(candidate, "Contents/Info.plist")));
  }

  const manifest = await readJson(join(ompBaseline, "source-manifest.json"));
  const packageVersion = string(manifest.value.packageVersion, "baseline packageVersion"), commit = string(manifest.value.sourceCommit, "baseline sourceCommit");
  const sourceFiles = list(manifest.value.sourceFiles, "baseline sourceFiles");
  const baselineIntegrity = await check("omp.baseline-integrity", "Preserved OMP source integrity", async () => {
    const invalid: string[] = [], sources: Evidence[] = [manifest.evidence];
    for (const entry of sourceFiles) {
      const evidence = await fileEvidence(sourcePath(join(ompBaseline, "sources"), string(entry.path, "source path")));
      sources.push({ ...evidence, url: entry.url });
      if (evidence.sha256 !== entry.sha256 || evidence.bytes !== entry.bytes) invalid.push(entry.path);
    }
    return { id: "omp.baseline-integrity", title: "Preserved OMP source integrity", status: invalid.length ? "invalid" : "unchanged", sources,
      details: invalid.length ? [`Source digest/size mismatch: ${invalid.join(", ")}`] : [`${sourceFiles.length} preserved source files match their manifest SHA-256 and sizes at ${commit}.`] };
  });
  const configured = await readJson(join(repository, "package.json"));
  const configuredNames = Object.keys(object(configured.value.dependencies, "dependencies")).filter(name => name.startsWith("@oh-my-pi/")).sort();
  checks.push(scalarCheck("omp.configured-pins", "Configured OMP dependency pins", Object.fromEntries(configuredNames.map(name => [name, packageVersion])),
    Object.fromEntries(configuredNames.map(name => [name, configured.value.dependencies[name]])), [configured.evidence, manifest.evidence], ["Exact string equality; ranges are drift. No install is run."]));
  checks.push(scalarCheck("bun.configured", "Configured Bun pin", `bun@${BUN_BASELINE}`, configured.value.packageManager, [configured.evidence], ["Expected version is the accepted runtime pin maintained in this tool."]));
  checks.push(scalarCheck("bun.report-runtime", "Bun executing this report", BUN_BASELINE, Bun.version, [await fileEvidence(process.execPath)], ["This is the report process, not proof of a running desktop/remote host executable or native OMP CLI version."]));
  await check("omp.lockfile", "Workspace lockfile observation", async () => ({ id: "omp.lockfile", title: "Workspace lockfile observation", status: "unknown", sources: [await fileEvidence(join(repository, "bun.lock"))],
    details: ["Current lockfile digest recorded for reproducibility. No independent accepted lockfile digest is preserved here; dependency resolution is checked from installed package manifests below."] }));
  const roots = new Map<string, string>();
  await check("omp.installed-packages", "Resolved installed OMP packages", async () => {
    const codingRoot = await packageRoot(repository, "@oh-my-pi/pi-coding-agent");
    roots.set("coding-agent", codingRoot);
    const names = [...new Set([...configuredNames, "@oh-my-pi/pi-catalog", "@oh-my-pi/pi-agent-core"])].sort(), installed: Record<string, string> = {}, sources: Evidence[] = [manifest.evidence];
    for (const name of names) {
      const root = configuredNames.includes(name) ? await packageRoot(repository, name) : await packageRoot(repository, name, codingRoot);
      const artifact = await readJson(join(root, "package.json"));
      if (artifact.value.name !== name) throw new Error(`Resolved package name mismatch at ${artifact.evidence.path}`);
      installed[name] = string(artifact.value.version, "installed version"); sources.push(artifact.evidence);
      if (name === "@oh-my-pi/pi-ai") roots.set("ai", root);
      if (name === "@oh-my-pi/pi-catalog") roots.set("catalog", root);
    }
    return scalarCheck("omp.installed-packages", "Resolved installed OMP packages", Object.fromEntries(names.map(name => [name, packageVersion])), installed, sources,
      ["Read-only real package resolution from workspace and coding-agent dependency directories. No OMP import, provider discovery, user configuration or credentials were read."]);
  });
  const sourceResults = new Map<string, Check>();
  async function inspectSources(label: string, resolveSource: (path: string) => string | undefined) {
    for (const entry of sourceFiles) {
      const id = `omp.${label}.source:${entry.path}`;
      const result = await check(id, `OMP ${label} source: ${entry.path}`, async () => {
        const path = resolveSource(entry.path);
        if (!path) return unknown(id, `OMP ${label} source: ${entry.path}`, "This source is not available in the supplied/resolved package layout.", [{ ...manifest.evidence, url: entry.url }]);
        if (baselineIntegrity.status === "invalid") return unknown(id, `OMP ${label} source: ${entry.path}`, "Preserved source integrity failed.");
        const evidence = await fileEvidence(path);
        return scalarCheck(id, `OMP ${label} source: ${entry.path}`, entry.sha256, evidence.sha256, [{ ...manifest.evidence, url: entry.url }, evidence],
          ["Static whole-file SHA-256; changed bytes require review and do not by themselves establish an API or behavioral break."]);
      }, true);
      if (label === "installed") sourceResults.set(entry.path, result);
    }
  }
  function installedSource(path: string): string | undefined {
    const match = /^packages\/([^/]+)\/(.+)$/.exec(path);
    if (match) { const root = roots.get(match[1]!); return root ? sourcePath(root, match[2]!) : undefined; }
    return path === "LICENSE" && roots.has("coding-agent") ? join(roots.get("coding-agent")!, "LICENSE") : undefined;
  }
  await inspectSources("installed", installedSource);
  const inventorySpecs = [
    { file: "settings-inventory.json", parse: settingRows, title: "Core setting descriptors", required: ["packages/coding-agent/src/config/settings-schema.ts"] },
    { file: "model-capabilities-inventory.json", parse: capabilityRows, title: "Model capabilities and configuration schemas", required: ["packages/catalog/src/types.ts", "packages/ai/src/types.ts", "packages/coding-agent/src/config/models-config-schema-bundle.ts"] },
    { file: "provider-options-inventory.json", parse: capabilityRows, title: "Provider request option interfaces", required: [] },
  ];
  for (const spec of inventorySpecs) await check(`omp.installed.${spec.file}`, `OMP installed: ${spec.title}`, async () => {
    const baseline = await readJson(join(ompBaseline, spec.file));
    if (baseline.value.sourceCommit !== commit) throw new Error(`Baseline inventory sourceCommit mismatch: ${spec.file}`);
    const rows = spec.parse(baseline.value, baseline.evidence);
    // Validate unique identities even when no candidate extraction is necessary.
    compareRows("validation", "validation", rows, rows, []);
    if (baselineIntegrity.status === "invalid") return unknown(`omp.installed.${spec.file}`, `OMP installed: ${spec.title}`, "Preserved source integrity failed.", [baseline.evidence]);
    if (spec.required.length) {
      const sourceChecks = spec.required.map(path => sourceResults.get(path));
      const verified = sourceChecks.every(result => result?.status === "unchanged");
      return { id: `omp.installed.${spec.file}`, title: `OMP installed: ${spec.title}`, status: verified ? "unchanged" : "unknown", sources: [baseline.evidence, ...sourceChecks.flatMap(result => result?.sources ?? [])],
        details: [verified ? `${rows.length} descriptor/field/declaration entries retained by exact source-byte agreement. No candidate code executed.` : "Relevant installed source differs or is unavailable. Descriptor drift is unknown until a candidate static inventory is supplied; no stale baseline is presented as current."],
        ...(verified ? { counts: { before: rows.length, after: rows.length, added: 0, removed: 0, changed: 0 } } : {}) };
    }
    // Provider source blobs were not preserved in the source manifest, but the
    // full declarations were. Compare those exact snippets to installed source.
    const failures: string[] = [], sources: Evidence[] = [baseline.evidence];
    for (const [name, raw] of Object.entries(object(baseline.value.interfaces, "provider interfaces"))) {
      const declaration = object(raw, name), url = string(declaration.source, "provider source"), relative = url.split(`/blob/${commit}/`)[1]?.split("#")[0];
      const path = relative ? installedSource(relative) : undefined;
      if (!path || !await exists(path)) { failures.push(`${name}: source unavailable`); continue; }
      const evidence = await fileEvidence(path), bytes = await readFile(path);
      if (sha256(bytes) !== evidence.sha256) throw new Error(`Provider source changed while reading: ${path}`);
      const source = bytes.toString("utf8");
      sources.push({ ...evidence, url });
      const expression = string(declaration.declarationExpression, "provider declaration");
      if (source.split(expression).length !== 2) failures.push(`${name}: exact declaration absent or ambiguous`);
    }
    return { id: `omp.installed.${spec.file}`, title: `OMP installed: ${spec.title}`, status: failures.length ? "unknown" : "unchanged", sources,
      details: failures.length ? failures : [`All ${Object.keys(baseline.value.interfaces).length} complete preserved interface declarations occur exactly once in the resolved source. Function bodies, inherited declarations and runtime provider behavior are not verified by this check.`] };
  });
  if (options.ompCandidatePackage) {
    const root = resolve(options.ompCandidatePackage);
    await check("omp.candidate-package", "Supplied candidate OMP package", async () => {
      const candidate = await readJson(join(root, "package.json"));
      if (candidate.value.name !== "@oh-my-pi/pi-coding-agent") throw new Error("Candidate package must be an unpacked @oh-my-pi/pi-coding-agent package");
      return scalarCheck("omp.candidate-package", "Supplied candidate OMP package", packageVersion, string(candidate.value.version, "candidate version"), [manifest.evidence, candidate.evidence],
        ["No candidate code is imported or executed; dependencies are not installed or resolved from this package."]);
    });
    await inspectSources("candidate-package", path => path.startsWith("packages/coding-agent/") ? sourcePath(root, path.slice("packages/coding-agent/".length)) : path === "LICENSE" ? join(root, path) : undefined);
  }
  if (options.ompCandidateInventory) {
    const directory = resolve(options.ompCandidateInventory);
    if (!await exists(directory)) throw new Error(`OMP candidate inventory directory does not exist: ${directory}`);
    await check("omp.candidate-inventory-provenance", "Candidate inventory provenance", async () => {
      if (!await exists(join(directory, "source-manifest.json"))) return unknown("omp.candidate-inventory-provenance", "Candidate inventory provenance", "No source manifest supplied. Inventory deltas are data comparisons with unverified source attribution.");
      const candidate = await readJson(join(directory, "source-manifest.json"));
      const unverified: string[] = [], invalid: string[] = [], sources: Evidence[] = [candidate.evidence];
      for (const entry of list(candidate.value.sourceFiles, "candidate sourceFiles")) {
        const path = sourcePath(join(directory, "sources"), string(entry.path, "candidate source path"));
        if (!await exists(path)) { unverified.push(entry.path); continue; }
        const artifact = await fileEvidence(path); sources.push({ ...artifact, url: entry.url });
        if (artifact.sha256 !== entry.sha256 || artifact.bytes !== entry.bytes) invalid.push(entry.path);
      }
      return { id: "omp.candidate-inventory-provenance", title: "Candidate inventory provenance", status: invalid.length ? "invalid" : "unknown", sources,
        details: [...(invalid.length ? [`Source digest/size mismatch: ${invalid.join(", ")}`] : []), ...(unverified.length ? [`Missing source copies: ${unverified.join(", ")}`] : ["All supplied source copies match the supplied manifest."]),
          "Candidate manifest attribution is self-declared, not authenticated by this report. Inventory extraction is not rerun; an inventory and a separately supplied package are not assumed to correspond."] };
    });
    for (const spec of inventorySpecs) await check(`omp.candidate.${spec.file}`, `OMP candidate: ${spec.title}`, async () => {
      const baseline = await readJson(join(ompBaseline, spec.file)), candidate = await readJson(join(directory, spec.file));
      string(candidate.value.sourceCommit, "candidate inventory sourceCommit");
      if (await exists(join(directory, "source-manifest.json"))) {
        const candidateManifest = await readJson(join(directory, "source-manifest.json"));
        if (candidate.value.sourceCommit !== candidateManifest.value.sourceCommit) throw new Error(`Candidate inventory/manifest sourceCommit mismatch: ${spec.file}`);
      }
      return compareRows(`omp.candidate.${spec.file}`, `OMP candidate: ${spec.title}`, spec.parse(baseline.value, baseline.evidence), spec.parse(candidate.value, candidate.evidence), [baseline.evidence, candidate.evidence],
        ["Exact static expressions, optionality, defaults and UI/capability declarations. Type aliases, inheritance, runtime guards and expression semantics are not evaluated. Full declaration changes can include comments or formatting."]);
    }, true);
  }
  checks.push(unknown("compatibility.runtime", "Runtime and migration compatibility", "Not run. SDK/RPC events, callback behavior, extension settings, permissions, accounts/broker rotation, provider/tool turns, import/migration/rollback and cross-device smoke contracts require separately authorized candidate execution. Static agreement is insufficient."));
  checks.push(unknown("compatibility.reference-behavior", "Reference UI and state behavior", "Not verified. Computer-use tooling refused live Codex access; this tool uses permitted static files only. Changed screens require user-supplied or another permitted reference route. Hosted flags/account behavior cannot be inferred from archive hashes."));
  const summary = { unchanged: 0, changed: 0, unknown: 0, invalid: 0, observedDrift: false, exitCode: 0 as 0 | 1 | 2 };
  for (const item of checks) summary[item.status]++;
  summary.observedDrift = summary.changed > 0;
  summary.exitCode = summary.invalid ? 1 : summary.changed ? 2 : 0;
  return { format: 1, generatedAt: options.generatedAt ?? new Date().toISOString(), purpose: "On-demand static upstream change report; no adoption or compatibility certification", checks, summary,
    limits: ["No downloads, scheduled checks, candidate execution, user configuration reads, provider requests, authentication changes or baseline replacement.",
      "Status unchanged means agreement only within each check's stated evidence. Unknown remains unknown even when the command exits 0.",
      "Running desktop/remote hosts and an independent machine OMP binary are outside this report; Bun.version describes this CLI process.",
      "Explicit candidate inventories are untrusted descriptive inputs. Their fields are compared without executing their extractor or candidate implementation."] };
}
function markdownText(value: unknown): string { return String(value).replace(/[\r\n]+/g, " ").replaceAll("|", "\\|").replaceAll("`", "\\`").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
export function renderMarkdown(report: UpstreamReport): string {
  const lines = ["# Upstream change report", "", report.purpose, "", `Generated: ${report.generatedAt}`, "", `Observed drift: **${report.summary.observedDrift ? "yes" : "no"}**. ${report.summary.unchanged} unchanged, ${report.summary.changed} changed, ${report.summary.unknown} unknown, ${report.summary.invalid} invalid. Exit ${report.summary.exitCode}.`, "",
    "No compatibility or visual parity pass is implied by matching hashes.", "", "| Check | Status | Evidence |", "| --- | --- | --- |"];
  for (const check of report.checks) lines.push(`| ${markdownText(check.title)} | ${check.status} | ${check.counts ? `${check.counts.before} → ${check.counts.after}; +${check.counts.added} / −${check.counts.removed} / ${check.counts.changed} changed. ` : ""}${markdownText(check.details.join(" "))} |`);
  for (const check of report.checks.filter(check => check.status === "changed" || check.status === "invalid")) {
    lines.push("", `## ${markdownText(check.title)}`, "");
    if (check.deltas?.length) {
      lines.push("| Item | Change | Changed facets |", "| --- | --- | --- |");
      for (const delta of check.deltas) lines.push(`| ${markdownText(delta.id)} | ${delta.kind} | ${markdownText(delta.facets.join(", "))} |`);
    } else if (check.before !== undefined || check.after !== undefined) lines.push(`Before: \`${markdownText(JSON.stringify(check.before))}\``, "", `After: \`${markdownText(JSON.stringify(check.after))}\``);
    for (const detail of check.details) lines.push("", markdownText(detail));
  }
  lines.push("", "## Source attribution", "", "The JSON report retains per-check and per-delta paths, hashes, pointers, native source URLs and line numbers. Exact inputs read:", "");
  const evidence = new Map<string, Evidence>();
  for (const check of report.checks) for (const source of check.sources) evidence.set(`${source.path}|${source.sha256 ?? ""}`, source);
  for (const source of evidence.values()) lines.push(`- ${markdownText(source.path)}${source.sha256 ? ` — SHA-256 \`${source.sha256}\`` : ""}${source.bytes !== undefined ? ` (${source.bytes} bytes)` : ""}${source.url ? `; ${markdownText(source.url)}` : ""}`);
  lines.push("", "## Limits", "");
  for (const limit of report.limits) lines.push(`- ${limit}`);
  return lines.join("\n") + "\n";
}
const HELP = `Usage: bun scripts/upstream-report.ts [options]
  --codex-app PATH                  Installed macOS bundle (default /Applications/ChatGPT.app)
  --codex-candidate PATH            Separate .app or preserved reference directory
  --omp-candidate-inventory DIR     Static JSON inventories and optional sources/manifest
  --omp-candidate-package DIR       Unpacked coding-agent package (read only; never executed)
  --out PREFIX                     Write PREFIX.json and PREFIX.md; refuse existing files
  --format json|markdown           stdout format (default markdown; ignored with --out)
  --help                           Show this help
Exit 0: no observed drift (unknown checks may remain). 2: observed drift. 1: invalid input/baseline/read failure.
`;
export function parseArgs(args: string[]): { options: ReportOptions; out?: string; format: "json" | "markdown"; help: boolean } {
  const result: { options: ReportOptions; out?: string; format: "json" | "markdown"; help: boolean } = { options: {}, format: "markdown", help: false };
  const names = { "--codex-app": "codexApp", "--codex-candidate": "codexCandidate", "--omp-candidate-inventory": "ompCandidateInventory", "--omp-candidate-package": "ompCandidatePackage" } as const;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help") { result.help = true; continue; }
    if (seen.has(arg)) throw new Error(`Duplicate option ${arg}`); seen.add(arg);
    if (!Object.hasOwn(names, arg) && !["--out", "--format"].includes(arg)) throw new Error(`Unknown option ${arg}`);
    const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (arg === "--out") result.out = resolve(value);
    else if (arg === "--format") { if (value !== "json" && value !== "markdown") throw new Error("--format must be json or markdown"); result.format = value; }
    else result.options[names[arg as keyof typeof names]] = resolve(value);
  }
  return result;
}
if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.help) console.log(HELP);
    else {
      const report = await buildReport(args.options), json = JSON.stringify(report, null, 2) + "\n", md = renderMarkdown(report);
      if (args.out) {
        if (await exists(`${args.out}.json`) || await exists(`${args.out}.md`)) throw new Error("Report output already exists; choose a fresh prefix");
        await mkdir(dirname(args.out), { recursive: true });
        await writeFile(`${args.out}.json`, json, { flag: "wx", mode: 0o600 });
        await writeFile(`${args.out}.md`, md, { flag: "wx", mode: 0o600 });
        console.log(JSON.stringify({ ...report.summary, json: `${args.out}.json`, markdown: `${args.out}.md` }, null, 2));
      } else console.log(args.format === "json" ? json : md);
      process.exitCode = report.summary.exitCode;
    }
  } catch (error) { console.error(errorText(error)); process.exitCode = 1; }
}
