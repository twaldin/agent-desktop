import path from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, databasePath] = process.argv.slice(2);
if (!packageRoot || !databasePath) throw new Error("Expected package root and database path");

const { SqliteAuthCredentialStore } = await import(
	pathToFileURL(path.join(packageRoot, "src/auth/sqlite-credential-store.ts")).href
);

process.send?.({ type: "ready" });
await new Promise<void>((resolve) => {
	process.on("message", (message) => {
		if ((message as { type?: string } | null)?.type === "open") resolve();
	});
});

const store = await SqliteAuthCredentialStore.open(databasePath);
store.close();
process.send?.({ type: "opened" });
process.disconnect?.();
