import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const mermaidBundle = createRequire(join(import.meta.dirname, "package.json")).resolve("mermaid/dist/mermaid.min.js");
const mermaidBridge = join(import.meta.dirname, "src/renderer/mermaid-sandbox-runtime.js");
async function mermaidDocument() {
  const scripts = await Promise.all([mermaidBundle, mermaidBridge].map(async file => (await readFile(file, "utf8")).replace(/<\/script/gi, "<\\/script")));
  const hashes = scripts.map(script => `'sha256-${createHash("sha256").update(script).digest("base64")}'`).join(" ");
  const policy = `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">${scripts.map(script => `<script>${script}</script>`).join("")}</head><body></body></html>`;
}

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react(), tailwindcss(), {
    name: "isolated-mermaid-document",
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: "mermaid-sandbox.html", source: await mermaidDocument() });
    },
    configureServer(server) {
      server.middlewares.use("/mermaid-sandbox.html", async (_request, response, next) => {
        try { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(await mermaidDocument()); }
        catch (error) { next(error); }
      });
      server.watcher.add(mermaidBridge);
      server.watcher.on("change", file => { if (file === mermaidBridge) server.ws.send({ type: "full-reload" }); });
    },
  }],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  worker: { format: "es" },
  build: { outDir: "dist/renderer", emptyOutDir: true },
});
