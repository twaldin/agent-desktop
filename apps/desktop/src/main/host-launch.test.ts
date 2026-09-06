import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHostLaunch } from "./host-launch";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function packagedFixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-host-launch-"));
  directories.push(root);
  const resources = join(root, "Resources");
  await mkdir(join(resources, "host/apps/host/src"), { recursive: true });
  await mkdir(join(resources, "runtime"), { recursive: true });
  await writeFile(join(resources, "host/apps/host/src/packaged-entry.ts"), "// fixture");
  await writeFile(join(resources, "runtime/bun"), "bun fixture");
  return { root, resources, entry: join(resources, "host/apps/host/src/packaged-entry.ts"), bun: join(resources, "runtime/bun") };
}

test("packaged launch ignores development executable and source overrides", async () => {
  const fixture = await packagedFixture();
  const personal = join(fixture.root, "personal");
  await mkdir(join(personal, "apps/host"), { recursive: true });
  const result = resolveHostLaunch({
    isPackaged: true,
    resourcesPath: fixture.resources,
    homeDirectory: fixture.root,
    environment: { AGENT_DESKTOP_BUN: join(personal, "bun"), AGENT_DESKTOP_PROJECT_ROOT: personal },
  });
  expect(result).toEqual({ bun: fixture.bun, entry: fixture.entry });
});

for (const missing of ["bun", "entry"] as const) test(`packaged launch refuses a missing ${missing} despite usable development paths`, async () => {
  const fixture = await packagedFixture();
  const personal = join(fixture.root, "personal");
  await mkdir(join(personal, "apps/host/src"), { recursive: true });
  await writeFile(join(personal, "bun"), "personal bun");
  await writeFile(join(personal, "apps/host/src/server.ts"), "personal server");
  const options = { resourcesPath: fixture.resources, homeDirectory: fixture.root,
    environment: { AGENT_DESKTOP_BUN: join(personal, "bun"), AGENT_DESKTOP_PROJECT_ROOT: personal } };
  // Establish that the override really is usable; the packaged rejection must not rely on a bad fixture path.
  expect(resolveHostLaunch({ ...options, isPackaged: false })).toEqual({ bun: join(personal, "bun"), entry: join(personal, "apps/host/src/server.ts") });
  await rm(fixture[missing]);
  expect(() => resolveHostLaunch({ ...options, isPackaged: true })).toThrow("host runtime is missing");
});

test("packaged launch rejects a runtime file escaping through a symlink", async () => {
  const fixture = await packagedFixture();
  const outside = join(fixture.root, "outside-bun");
  await writeFile(outside, "outside");
  await rm(fixture.bun);
  await symlink(outside, fixture.bun);
  expect(() => resolveHostLaunch({
    isPackaged: true,
    resourcesPath: fixture.resources,
    homeDirectory: fixture.root,
    environment: {},
  })).toThrow("outside its app bundle");
});

test("development launch retains explicit source and executable overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-host-launch-dev-"));
  directories.push(root);
  const project = join(root, "project");
  const bun = join(root, "custom-bun");
  await mkdir(join(project, "apps/host/src"), { recursive: true });
  await writeFile(join(project, "apps/host/src/server.ts"), "// dev fixture");
  await writeFile(bun, "dev bun");
  expect(resolveHostLaunch({
    isPackaged: false,
    resourcesPath: join(root, "Resources"),
    homeDirectory: root,
    environment: { AGENT_DESKTOP_BUN: bun, AGENT_DESKTOP_PROJECT_ROOT: project },
  })).toEqual({ bun, entry: join(project, "apps/host/src/server.ts") });
});
