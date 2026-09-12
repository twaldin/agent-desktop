import { readGitActionContext } from "../git-action-context";
import { WorkspaceService } from "../service";

const cwd = process.env.GIT_ACTION_CONTEXT_FIXTURE_CWD;
if (!cwd) throw new Error("GIT_ACTION_CONTEXT_FIXTURE_CWD is required.");

try {
  const context = await readGitActionContext(new WorkspaceService(cwd));
  console.log(JSON.stringify({ ok: true, push: context.push }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, name: error instanceof Error ? error.name : "UnknownError",
    code: error instanceof Error && "code" in error ? error.code : undefined }));
}
