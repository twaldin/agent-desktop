// Real competing writer process for the original-session admission slice.
// Runs the actual patched native module: no mocked lock, no fake SessionManager,
// no provider traffic. Driven over the Bun IPC channel by the contract runner.
import path from "node:path";

interface AdmissionRequest {
	ownershipDirectory: string;
	binding: unknown;
	source: unknown;
	commandId: string;
}

interface ActorCommand {
	type: "append" | "title" | "transition" | "close" | "hard-exit" | "ownership";
	text?: string;
	action?: "newSession" | "fork" | "moveTo" | "branch" | "persistCopy" | "setSessionFile" | "dropSession";
	target?: string;
}

const packageRoot = process.env.ORIGINAL_ADMISSION_PACKAGE!;
const { openAdmittedOriginal } = await import(path.join(packageRoot, "src/session/original-session-ownership.ts"));

const request = (await Bun.file(process.argv[2]!).json()) as AdmissionRequest;

function describe(error: unknown): { code: string; reason: string; message: string } {
	const failure = error as { code?: unknown; reason?: unknown; message?: unknown };
	return {
		code: typeof failure?.code === "string" ? failure.code : "UNCLASSIFIED",
		reason: typeof failure?.reason === "string" ? failure.reason : "",
		message: String(failure?.message ?? error),
	};
}

let manager: Awaited<ReturnType<typeof openAdmittedOriginal>>;
try {
	manager = await openAdmittedOriginal(request);
} catch (error) {
	process.send?.({ type: "rejected", ...describe(error) });
	process.exit(73);
}

process.send?.({
	type: "ready",
	nativeId: manager.getSessionId(),
	file: manager.getSessionFile(),
	recordedCwd: manager.getRecordedCwd(),
	entryCount: manager.getEntries().length,
	ownership: manager.getOriginalOwnership(),
});

process.on("message", async (command: ActorCommand) => {
	try {
		switch (command.type) {
			case "append":
				manager.appendCustomEntry("original-admission-actor", { text: command.text ?? "" });
				await manager.flush();
				process.send?.({ type: "appended", entryCount: manager.getEntries().length });
				return;
			case "title":
				await manager.setSessionName(command.text ?? "actor title", "auto");
				await manager.flush();
				process.send?.({ type: "titled", title: manager.getSessionName() });
				return;
			case "ownership":
				process.send?.({ type: "ownership", ownership: manager.getOriginalOwnership() });
				return;
			case "transition": {
				// Every one of these must refuse BEFORE touching the transcript.
				const attempt = async () => {
					if (command.action === "newSession") return manager.newSession();
					if (command.action === "fork") return manager.fork();
					if (command.action === "moveTo") return manager.moveTo(command.target!);
					if (command.action === "branch") return manager.createBranchedSession(manager.getLeafId()!);
					if (command.action === "persistCopy") return manager.persistCopy();
					if (command.action === "setSessionFile") return manager.setSessionFile(command.target!);
					return manager.dropSession(command.target!);
				};
				try {
					await attempt();
					process.send?.({ type: "transition", refused: false });
				} catch (error) {
					process.send?.({
						type: "transition",
						refused: true,
						...describe(error),
						nativeId: manager.getSessionId(),
						file: manager.getSessionFile(),
					});
				}
				return;
			}
			case "close":
				manager.seal();
				await manager.close();
				process.send?.({ type: "closed", ownership: manager.getOriginalOwnership() });
				process.exit(0);
				return;
			case "hard-exit":
				// Simulated crash: no seal, no close, no lock release call.
				process.kill(process.pid, "SIGKILL");
				return;
		}
	} catch (error) {
		process.send?.({ type: "error", ...describe(error) });
	}
});
