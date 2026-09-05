// Writes labelled fixtures to an explicit temporary native auth store only.
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
const auth = await discoverAuthStorage(process.argv[2]);
try {
  const provider = "openai";
  if (process.argv[3] === "key") {
    auth.upsertCredential(provider, { type: "api_key", key: "contract-api-key" });
  } else {
    for (const account of ["first", "second"]) auth.upsertCredential(provider, {
      type: "oauth", access: `contract-access-${account}`, refresh: `contract-refresh-${account}`,
      expires: Date.now() + 86_400_000, accountId: `contract-${account}`, email: `${account}@example.invalid`,
    });
  }
  process.stdout.write("temporary native fixtures written\n");
} finally { auth.close(); }
