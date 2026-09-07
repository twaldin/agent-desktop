import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceOpenTarget } from "@agent-desktop/shared";
import { WorkspaceError } from "./workspace";

const execute = promisify(execFile);
type Candidate = WorkspaceOpenTarget & { paths: string[]; mode: "file-manager" | "system-default" | "mac-app" | "mac-terminal" | "linux-terminal" | "executable" };

export interface WorkspaceFileOpenRuntime {
  platform: NodeJS.Platform;
  environment: Partial<Pick<NodeJS.ProcessEnv, "DISPLAY" | "WAYLAND_DISPLAY">>;
  homeDirectory: string;
  available(path: string, kind: "application" | "executable"): Promise<boolean>;
  launch(executable: string, args: string[], cwd: string): Promise<void>;
}

async function available(path: string, kind: "application" | "executable"): Promise<boolean> {
  try {
    await access(path, kind === "executable" ? constants.X_OK : constants.R_OK);
    const metadata = await stat(path);
    return kind === "executable" ? metadata.isFile() : metadata.isDirectory();
  } catch { return false; }
}

export function systemWorkspaceFileOpenRuntime(): WorkspaceFileOpenRuntime {
  const platform = process.platform;
  return {
    platform,
    environment: { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY },
    homeDirectory: homedir(),
    available,
    async launch(executable, args, cwd) {
      if (platform === "darwin") { await execute(executable, args, { cwd, timeout: 10_000 }); return; }
      // Linux GUI processes may remain attached for their whole window lifetime.
      // Confirm process admission, then detach without a shell or a kill timeout.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, args, { cwd, detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
    },
  };
}

/** Deliberately bounded native-style catalog. Arbitrary PATH entries, EDITOR,
 * shell commands and caller-provided arguments never become launch targets. */
function candidates(runtime: WorkspaceFileOpenRuntime): Candidate[] {
  if (runtime.platform === "darwin") {
    const applications = (name: string) => [`/Applications/${name}.app`, join(runtime.homeDirectory, "Applications", `${name}.app`)];
    return [
      { id: "vscode", label: "VS Code", kind: "editor", paths: applications("Visual Studio Code"), mode: "mac-app" },
      { id: "cursor", label: "Cursor", kind: "editor", paths: applications("Cursor"), mode: "mac-app" },
      { id: "zed", label: "Zed", kind: "editor", paths: applications("Zed"), mode: "mac-app" },
      { id: "sublimeText", label: "Sublime Text", kind: "editor", paths: applications("Sublime Text"), mode: "mac-app" },
      { id: "systemDefault", label: "Default app", kind: "editor", paths: ["/usr/bin/open"], mode: "system-default" },
      { id: "terminal", label: "Terminal", kind: "terminal", paths: ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"], mode: "mac-terminal" },
      { id: "ghostty", label: "Ghostty", kind: "terminal", paths: applications("Ghostty"), mode: "mac-terminal" },
      { id: "fileManager", label: "Finder", kind: "file-manager", paths: ["/usr/bin/open"], mode: "file-manager" },
    ];
  }
  if (runtime.platform === "linux") return [
    { id: "vscode", label: "VS Code", kind: "editor", paths: ["/usr/bin/code", "/usr/local/bin/code", "/snap/bin/code"], mode: "executable" },
    { id: "vscodium", label: "VSCodium", kind: "editor", paths: ["/usr/bin/codium", "/usr/local/bin/codium", "/snap/bin/codium"], mode: "executable" },
    { id: "cursor", label: "Cursor", kind: "editor", paths: ["/usr/bin/cursor", "/usr/local/bin/cursor"], mode: "executable" },
    { id: "zed", label: "Zed", kind: "editor", paths: ["/usr/bin/zed", "/usr/local/bin/zed"], mode: "executable" },
    { id: "sublimeText", label: "Sublime Text", kind: "editor", paths: ["/usr/bin/subl", "/usr/local/bin/subl"], mode: "executable" },
    { id: "systemDefault", label: "Default app", kind: "editor", paths: ["/usr/bin/xdg-open"], mode: "system-default" },
    { id: "terminal", label: "Terminal", kind: "terminal", paths: ["/usr/bin/gnome-terminal", "/usr/bin/konsole", "/usr/bin/kitty"], mode: "linux-terminal" },
    { id: "ghostty", label: "Ghostty", kind: "terminal", paths: ["/usr/bin/ghostty", "/usr/local/bin/ghostty"], mode: "linux-terminal" },
    { id: "fileManager", label: "File manager", kind: "file-manager", paths: ["/usr/bin/xdg-open"], mode: "file-manager" },
  ];
  return [];
}

export class WorkspaceFileOpen {
  constructor(private runtime: WorkspaceFileOpenRuntime = systemWorkspaceFileOpenRuntime()) {}

  private async installed(): Promise<Array<{ target: WorkspaceOpenTarget; candidate: Candidate; path: string }>> {
    if (this.runtime.platform === "linux" && !this.runtime.environment.DISPLAY && !this.runtime.environment.WAYLAND_DISPLAY) return [];
    if (this.runtime.platform === "darwin" && !await this.runtime.available("/usr/bin/open", "executable")) return [];
    const result: Array<{ target: WorkspaceOpenTarget; candidate: Candidate; path: string }> = [];
    for (const candidate of candidates(this.runtime)) {
      for (const path of candidate.paths) {
        const kind = candidate.mode === "mac-app" || candidate.mode === "mac-terminal" ? "application" : "executable";
        if (!await this.runtime.available(path, kind)) continue;
        result.push({ target: { id: candidate.id, label: candidate.label, kind: candidate.kind }, candidate, path });
        break;
      }
    }
    return result;
  }

  async options(path: string): Promise<{ type: "file.open-options"; path: string; targets: WorkspaceOpenTarget[]; preferredTargetId?: string; availabilityReason?: string }> {
    const installed = await this.installed(), targets = installed.map(item => item.target);
    return { type: "file.open-options", path, targets,
      ...(targets.some(target => target.id === "fileManager") ? { preferredTargetId: "fileManager" } : {}),
      ...(targets.length ? {} : { availabilityReason: this.runtime.platform === "linux" && !this.runtime.environment.DISPLAY && !this.runtime.environment.WAYLAND_DISPLAY
        ? "This Linux host has no graphical desktop session." : "No supported external file application is installed on this host." }),
    };
  }

  async open(cwd: string, targetId: string, resolveFile: () => Promise<string>): Promise<{ type: "file.open"; targetId: string }> {
    const installation = (await this.installed()).find(item => item.target.id === targetId);
    if (!installation) throw new WorkspaceError("OPEN_TARGET_UNAVAILABLE", "The selected external file application is unavailable on this host. Refresh the Open menu.");
    // Discovery is asynchronous. Resolve the owned file only after it completes
    // so a path or directory swap cannot reuse a stale pre-discovery binding.
    const canonicalPath = await resolveFile();
    const { candidate } = installation;
    const executable = candidate.mode === "mac-app" || candidate.mode === "mac-terminal" || (candidate.mode === "file-manager" || candidate.mode === "system-default") && this.runtime.platform === "darwin" ? "/usr/bin/open" : installation.path;
    const args = candidate.mode === "mac-app" ? ["-a", installation.path, canonicalPath]
      : candidate.mode === "file-manager" ? this.runtime.platform === "darwin" ? ["-R", canonicalPath] : [dirname(canonicalPath)]
      : candidate.mode === "system-default" ? [canonicalPath]
      : candidate.mode === "mac-terminal" ? installation.target.id === "ghostty"
        ? ["-na", installation.path, "--args", `--working-directory=${dirname(canonicalPath)}`]
        : ["-a", installation.path, dirname(canonicalPath)]
      : candidate.mode === "linux-terminal" ? installation.path.endsWith("gnome-terminal") ? [`--working-directory=${dirname(canonicalPath)}`]
        : installation.path.endsWith("konsole") ? ["--workdir", dirname(canonicalPath)]
        : installation.target.id === "ghostty" ? [`--working-directory=${dirname(canonicalPath)}`] : [`--directory=${dirname(canonicalPath)}`]
      : [canonicalPath];
    try { await this.runtime.launch(executable, args, cwd); }
    catch { throw new WorkspaceError("OUTCOME_UNKNOWN", "The external file application launch was dispatched but could not be confirmed. Inspect the owning host before retrying this exact command receipt."); }
    return { type: "file.open", targetId };
  }
}
