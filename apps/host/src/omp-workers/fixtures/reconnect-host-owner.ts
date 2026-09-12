import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { WorkerClient } from "../runtime";

const [output,socketPath]=process.argv.slice(2);
if(!output||!socketPath)throw new Error("Usage: reconnect-host-owner <output> <socket>");
const workerPath=new URL("../entry.ts",import.meta.url).pathname;
const client=new WorkerClient({workerPath,startupTimeoutMs:10_000,shutdownTimeoutMs:3_000,
  environment:{...process.env,PI_DISABLE_DOTENV:"1"}});
const endpoint=await client.enableReconnect(socketPath,randomBytes(32).toString("hex"),randomUUID());
await writeFile(output,JSON.stringify(endpoint));
setInterval(()=>{},60_000);
