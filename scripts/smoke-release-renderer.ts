export type RendererTarget = { type: string; url: string; webSocketDebuggerUrl: string };
export type RendererDocumentEvidence = {
  href: string;
  readyState: string;
  rootPresent: boolean;
  moduleScripts: string[];
};

const RENDERER_DOCUMENT_SUFFIX = "/dist/renderer/index.html";

function filePath(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "file:" ? decodeURIComponent(url.pathname) : undefined;
  } catch { return; }
}

export function selectPackagedRendererTarget(targets: RendererTarget[]): RendererTarget | undefined {
  return targets.find(target => target.type === "page" && target.webSocketDebuggerUrl.length > 0
    && filePath(target.url)?.endsWith(RENDERER_DOCUMENT_SUFFIX));
}

export function rendererTargetSummary(targets: RendererTarget[]): string {
  return JSON.stringify(targets.map(({ type, url }) => ({ type, url })));
}

export function admitPackagedRendererDocument(
  expectedTargetUrl: string,
  evidence: RendererDocumentEvidence,
): string | undefined {
  const expectedPath = filePath(expectedTargetUrl), documentPath = filePath(evidence.href);
  if (documentPath !== expectedPath || evidence.readyState === "loading") return;
  const expectedDocument = documentPath?.endsWith(RENDERER_DOCUMENT_SUFFIX) === true;
  const expectedAssetPrefix = expectedPath?.slice(0, -"index.html".length).concat("assets/index-");
  const expectedModules = evidence.moduleScripts.filter(source => {
    const path = filePath(source);
    return expectedAssetPrefix !== undefined && path?.startsWith(expectedAssetPrefix) === true && path.endsWith(".js");
  });
  if (!expectedDocument || !evidence.rootPresent || expectedModules.length !== 1 || evidence.moduleScripts.length !== 1) {
    throw new Error(`The packaged desktop CDP target is not the initialized app document: ${JSON.stringify(evidence)}.`);
  }
  return expectedModules[0];
}
