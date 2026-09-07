import { homedir } from "node:os";

const [project, explicitFile] = process.argv.slice(2);
if (!project || !explicitFile) throw new Error("The dotenv isolation probe requires explicit paths.");
process.chdir(project);

const native = await import("@oh-my-pi/pi-utils/env");
const dirs = await import("@oh-my-pi/pi-utils/dirs");
const names = [
	"PROJECT_DOTENV_SENTINEL",
	"AGENT_DOTENV_SENTINEL",
	"CONFIG_DOTENV_SENTINEL",
	"HOME_DOTENV_SENTINEL",
	"PI_CONFIG_FILES",
	"OPENAI_API_KEY",
] as const;
const loaded = Object.fromEntries(names.map(name => [name, process.env[name] !== undefined]));
const parsed = native.parseEnvFile(explicitFile);
const child = native.filterChildShellEnv({ ...process.env, EXPLICIT_CHILD_VALUE: "kept" }, project);

process.stdout.write(JSON.stringify({
	loaded,
	homePreserved: homedir() === process.env.HOME,
	agentDirPreserved: dirs.getAgentDir() === process.env.EXPECTED_AGENT_DIR,
	managedRolePreserved: process.env.MANAGED_ROLE === "explicit",
	explicitParseWorks: parsed.EXPLICIT_PARSE_SENTINEL === "present",
	childValuePreserved: child.EXPLICIT_CHILD_VALUE === "kept",
	execArgvNoEnvFile: process.execArgv.includes("--no-env-file"),
}) + "\n");
