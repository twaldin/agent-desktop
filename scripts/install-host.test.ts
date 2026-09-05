import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAC_HOST_LABEL, renderLaunchAgent, renderSystemdUnit, serviceLayout } from "./install-host";
import { validateVersion } from "./package-host";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("installed host service configuration", () => {
  test("standalone installer imports before its production dependencies are installed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-standalone-installer-")); directories.push(directory);
    for (const file of ["scripts/install-host.ts", "scripts/terminal-upgrade-guard.ts", "apps/host/src/terminals/native-store.ts", "apps/host/src/terminals/bundle.ts", "apps/host/src/terminals/error.ts"]) {
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await copyFile(join(import.meta.dir, "..", file), join(directory, file));
    }
    const child = Bun.spawn([process.execPath, "--eval", 'const module = await import("./scripts/install-host.ts"); if (module.serviceLayout({platform:"linux", homeDirectory:"/home/fixture"}).platform !== "linux") throw new Error("Installer did not load");'], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(error).toBe(""); expect(code).toBe(0);
  });

  test("macOS keeps the native home and app data separate from versioned binaries", () => {
    const layout = serviceLayout({ platform: "darwin", homeDirectory: "/Users/test user" });
    const source = renderLaunchAgent(layout);
    expect(layout.dataDirectory).toBe("/Users/test user/Library/Application Support/Agent Desktop");
    expect(layout.serviceFile).toBe(`/Users/test user/Library/LaunchAgents/${MAC_HOST_LABEL}.plist`);
    expect(source).toContain("/Users/test user/.local/share/agent-desktop-host/current/bin/bun");
    expect(source).toContain("/Users/test user/.local/share/agent-desktop-host/current/apps/host/src/server.ts");
    expect(source).toContain("<key>WorkingDirectory</key><string>/Users/test user</string>");
    expect(source).not.toContain("<key>HOME</key>");
    expect(source).not.toContain("OMP_AGENT_DIR");
    expect(source).not.toContain("--watch");
  });

  test("generated launchd XML preserves paths containing XML characters", async () => {
    const layout = serviceLayout({ platform: "darwin", homeDirectory: '/Users/A & B "test"' });
    const source = renderLaunchAgent(layout);
    expect(source).toContain("A &amp; B &quot;test&quot;");
    if (process.platform === "darwin") {
      const directory = await mkdtemp(join(tmpdir(), "agent-desktop-plist-"));
      directories.push(directory);
      const file = join(directory, "host.plist");
      await writeFile(file, source);
      const result = Bun.spawnSync(["/usr/bin/plutil", "-lint", file], { stdout: "pipe", stderr: "pipe" });
      expect(result.success).toBe(true);
      const parsed = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", file], { stdout: "pipe", stderr: "pipe" });
      const value = JSON.parse(new TextDecoder().decode(parsed.stdout));
      expect(value.WorkingDirectory).toBe(layout.homeDirectory);
      expect(value.ProgramArguments).toHaveLength(2);
      expect(value.EnvironmentVariables.AGENT_DESKTOP_DATA_DIR).toBe(layout.dataDirectory);
    }
  });

  test("Linux uses a user unit with explicit runtime and worker lifecycle", () => {
    const layout = serviceLayout({ platform: "linux", homeDirectory: "/home/test" });
    const unit = renderSystemdUnit(layout);
    expect(layout.dataDirectory).toBe("/home/test/.local/share/agent-desktop");
    expect(unit).toContain('ExecStart="/home/test/.local/share/agent-desktop-host/current/bin/bun"');
    expect(unit).toContain("WorkingDirectory=~");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("User=");
    expect(unit).not.toContain("HOME=");
  });

  test("systemd escaping prevents path characters becoming specifiers or variables", () => {
    const layout = serviceLayout({ platform: "linux", homeDirectory: '/home/Test %u $USER "quoted"' });
    const unit = renderSystemdUnit(layout);
    const exec = unit.split("\n").find(line => line.startsWith("ExecStart="))!;
    expect(exec).toContain("%%u");
    expect(exec).toContain("$$USER");
    expect(exec).toContain('\\"quoted\\"');
    expect(unit).toContain("WorkingDirectory=~");
  });

  (process.platform === "linux" ? test : test.skip)("systemd's actual parser accepts the generated unit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-desktop-systemd-"));
    directories.push(directory);
    const layout = serviceLayout({ platform: "linux", homeDirectory: directory, installDirectory: join(directory, "release %literal space") });
    const binary = join(layout.installDirectory, "current/bin/bun");
    await mkdir(join(layout.installDirectory, "current/bin"), { recursive: true });
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
    await chmod(binary, 0o700);
    const service = join(directory, "agent-desktop-parser-test.service");
    await writeFile(service, renderSystemdUnit(layout));
    const result = Bun.spawnSync(["/usr/bin/systemd-analyze", "verify", service], { stdout: "pipe", stderr: "pipe" });
    expect(result.success).toBe(true);
  });

  test("version and path validation reject traversal and control characters", () => {
    expect(validateVersion("0.1.0-spike.20260905")).toBe("0.1.0-spike.20260905");
    for (const version of ["../escape", "/absolute", "", "a/b", "version\nnext"]) expect(() => validateVersion(version)).toThrow();
    expect(() => serviceLayout({ homeDirectory: "relative" })).toThrow();
    expect(() => serviceLayout({ homeDirectory: "/home/test\nnew" })).toThrow();
    expect(() => serviceLayout({ platform: "win32" })).toThrow();
  });
});
