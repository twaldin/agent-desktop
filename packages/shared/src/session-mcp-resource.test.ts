import { expect, test } from "bun:test";
import { parseNativeSessionMcpResourceRequest, parseNativeSessionMcpResourceResult } from "./session-mcp-resource";

test("resource codecs preserve exact identities and empty text or blobs", () => {
	expect(parseNativeSessionMcpResourceRequest({ epoch: "epoch", expectedRevision: 2, serverName: " server ", uri: "fixture://{ value }" }))
		.toEqual({ epoch: "epoch", expectedRevision: 2, serverName: " server ", uri: "fixture://{ value }" });
	expect(parseNativeSessionMcpResourceResult({ contents: [
		{ uri: "fixture://text", mimeType: "text/html", text: "\0<body>inert</body>" },
		{ uri: "fixture://binary", blob: "Zg" },
	] })).toEqual({ contents: [
		{ uri: "fixture://text", mimeType: "text/html", text: "\0<body>inert</body>" },
		{ uri: "fixture://binary", blob: "Zg" },
	] });
});

test("resource result rejects ambiguous, malformed base64, excessive, and unknown content", () => {
	expect(() => parseNativeSessionMcpResourceResult({ contents: [{ uri: "fixture://one", text: "a", blob: "YQ==" }] })).toThrow("exactly one");
	expect(() => parseNativeSessionMcpResourceResult({ contents: [{ uri: "fixture://one", blob: "not base64" }] })).toThrow("blob");
	expect(() => parseNativeSessionMcpResourceResult({ contents: [{ uri: "fixture://one", blob: "Zh==" }] })).toThrow("blob");
	expect(() => parseNativeSessionMcpResourceResult({ contents: Array.from({ length: 257 }, () => ({ uri: "fixture://one", text: "" })) })).toThrow("contents");
	expect(() => parseNativeSessionMcpResourceResult({ contents: [{ uri: "fixture://one", text: "safe", html: "<script>" }] })).toThrow("field");
	expect(() => parseNativeSessionMcpResourceResult({ contents: [{ uri: "fixture://one", text: "x".repeat(2 * 1024 * 1024) }] })).toThrow("2 MiB");
});
