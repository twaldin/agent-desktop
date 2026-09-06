import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { assertBundledRuntime } from "./runtime-ownership";

const VERSION = "18.1.10";
const DIRECT = ["pi-ai", "pi-coding-agent", "pi-natives", "pi-tui", "pi-utils"];
const roots: string[] = [];

interface Fixture {
  container: string;
  hostRoot: string;
  executablePath: string;
  packagePath(name: string): string;
}

function packagePath(hostRoot: string, name: string): string {
  return join(hostRoot, "node_modules", ...name.split("/"));
}

function writePackage(hostRoot: string, name: string, extra: Record<string, unknown> = {}): string {
  const root = packagePath(hostRoot, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: VERSION, main: "index.js", ...extra }));
  writeFileSync(join(root, "index.js"), "export const fixture = true;\n");
  return root;
}

function fixture(layout: "installed" | "desktop" = "installed"): Fixture {
  const container = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-owner-")));
  roots.push(container);
  const hostRoot = layout === "installed" ? join(container, "host") : join(container, "Resources", "host");
  mkdirSync(join(hostRoot, "node_modules", "@oh-my-pi"), { recursive: true });
  const executablePath = layout === "installed" ? join(hostRoot, "bin", "bun") : join(dirname(hostRoot), "runtime", "bun");
  mkdirSync(dirname(executablePath), { recursive: true });
  writeFileSync(executablePath, "fixture bun\n");
  chmodSync(executablePath, 0o755);
  writeFileSync(join(hostRoot, "host-artifact.json"), JSON.stringify({
    format: 1, version: "fixture", bunVersion: "1.3.14", ompVersion: VERSION, files: {},
  }));
  for (const name of DIRECT) writePackage(hostRoot, `@oh-my-pi/${name}`);
  return { container, hostRoot, executablePath, packagePath: name => packagePath(hostRoot, name) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bundled runtime ownership", () => {
  test("accepts installed and desktop layouts and reports direct and recursive package ownership", () => {
    for (const layout of ["installed", "desktop"] as const) {
      const item = fixture(layout);
      writePackage(item.hostRoot, "@oh-my-pi/pi-wire", { dependencies: { "@oh-my-pi/pi-utils": VERSION } });
      writePackage(item.hostRoot, `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`);
      writeFileSync(join(item.packagePath("@oh-my-pi/pi-ai"), "package.json"), JSON.stringify({
        name: "@oh-my-pi/pi-ai", version: VERSION, main: "index.js",
        dependencies: { "@oh-my-pi/pi-wire": VERSION },
      }));
      writeFileSync(join(item.packagePath("@oh-my-pi/pi-natives"), "package.json"), JSON.stringify({
        name: "@oh-my-pi/pi-natives", version: VERSION, main: "index.js",
        optionalDependencies: { [`@oh-my-pi/pi-natives-${process.platform}-${process.arch}`]: VERSION },
      }));

      const report = assertBundledRuntime(item.hostRoot, item.executablePath);
      expect(report).toMatchObject({ hostRoot: item.hostRoot, executablePath: item.executablePath, bunVersion: "1.3.14", ompVersion: VERSION });
      expect(report.packages.map(pkg => pkg.name)).toContain("@oh-my-pi/pi-wire");
      expect(report.packages.map(pkg => pkg.name)).toContain(`@oh-my-pi/pi-natives-${process.platform}-${process.arch}`);
      for (const direct of DIRECT) {
        const found = report.packages.find(pkg => pkg.name === `@oh-my-pi/${direct}`);
        expect(found?.resolvedPath).toBe(join(found!.packageRoot, "index.js"));
      }
    }
  });

  test("rejects artifact, package, and dependency pin mismatches", () => {
    const artifact = fixture();
    writeFileSync(join(artifact.hostRoot, "host-artifact.json"), JSON.stringify({ format: 1, version: "fixture", bunVersion: "1.3.13", ompVersion: VERSION, files: {} }));
    expect(() => assertBundledRuntime(artifact.hostRoot, artifact.executablePath)).toThrow("metadata does not match");

    const direct = fixture();
    writeFileSync(join(direct.packagePath("@oh-my-pi/pi-ai"), "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-ai", version: "18.1.9", main: "index.js" }));
    expect(() => assertBundledRuntime(direct.hostRoot, direct.executablePath)).toThrow("must be version 18.1.10");

    const dependency = fixture();
    writePackage(dependency.hostRoot, "@oh-my-pi/pi-wire");
    writeFileSync(join(dependency.packagePath("@oh-my-pi/pi-ai"), "package.json"), JSON.stringify({
      name: "@oh-my-pi/pi-ai", version: VERSION, main: "index.js", dependencies: { "@oh-my-pi/pi-wire": "^18.1.10" },
    }));
    expect(() => assertBundledRuntime(dependency.hostRoot, dependency.executablePath)).toThrow("does not pin @oh-my-pi/pi-wire");
  });

  test("rejects executable and dependency symlinks that leave the artifact", () => {
    const executable = fixture();
    const externalExecutable = join(executable.container, "outside-bun");
    writeFileSync(externalExecutable, "outside\n"); chmodSync(externalExecutable, 0o755);
    unlinkSync(executable.executablePath); symlinkSync(externalExecutable, executable.executablePath);
    expect(() => assertBundledRuntime(executable.hostRoot, executable.executablePath)).toThrow(/regular file|not owned/);

    const dependency = fixture();
    const externalRoot = join(dependency.container, "outside-package");
    mkdirSync(externalRoot); writeFileSync(join(externalRoot, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-wire", version: VERSION, main: "index.js" }));
    writeFileSync(join(externalRoot, "index.js"), "export {};\n");
    writeFileSync(join(dependency.packagePath("@oh-my-pi/pi-ai"), "package.json"), JSON.stringify({
      name: "@oh-my-pi/pi-ai", version: VERSION, main: "index.js", dependencies: { "@oh-my-pi/pi-wire": VERSION },
    }));
    const dependencyLink = dependency.packagePath("@oh-my-pi/pi-wire");
    symlinkSync(externalRoot, dependencyLink);
    expect(() => assertBundledRuntime(dependency.hostRoot, dependency.executablePath)).toThrow("redirects outside bundled node_modules");
  });

  test("does not resolve an absent bundled SDK from a nearby external package", () => {
    const item = fixture();
    unlinkSync(join(item.packagePath("@oh-my-pi/pi-ai"), "index.js"));
    const nearby = join(item.container, "node_modules", "@oh-my-pi", "pi-ai");
    mkdirSync(nearby, { recursive: true });
    writeFileSync(join(nearby, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-ai", version: VERSION, main: "index.js" }));
    writeFileSync(join(nearby, "index.js"), "export {};\n");
    expect(() => assertBundledRuntime(item.hostRoot, item.executablePath)).toThrow("SDK entrypoint resolves outside its bundled package");
  });
});
