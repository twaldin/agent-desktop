export interface NativeSessionMcpResourceRequest {
	epoch: string;
	expectedRevision: number;
	serverName: string;
	uri: string;
}

export interface NativeSessionMcpResourceResult {
	contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
}

const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native MCP resource value.");
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unsupported native MCP resource field.");
}

function text(value: unknown, maxBytes: number, empty = false): string {
	if (typeof value !== "string" || (!empty && !value) || value.includes("\0") || encoder.encode(value).byteLength > maxBytes) {
		throw new Error("Invalid native MCP resource text.");
	}
	return value;
}

function bodyText(value: unknown): string {
	if (typeof value !== "string" || encoder.encode(value).byteLength > MAX_RESULT_BYTES) throw new Error("Invalid native MCP resource body.");
	return value;
}

function revision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid native MCP resource revision.");
	return value;
}

function base64(value: unknown): string {
	const encoded = bodyText(value);
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
		throw new Error("Invalid native MCP resource blob.");
	}
	const firstPadding = encoded.indexOf("=");
	const data = firstPadding < 0 ? encoded : encoded.slice(0, firstPadding);
	const padding = encoded.length - data.length;
	const remainder = data.length % 4;
	if (remainder === 1 || (padding > 0 && (encoded.length % 4 !== 0 || padding !== 4 - remainder))) throw new Error("Invalid native MCP resource blob.");
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	if ((remainder === 2 && (alphabet.indexOf(data.at(-1)!) & 15) !== 0) || (remainder === 3 && (alphabet.indexOf(data.at(-1)!) & 3) !== 0)) {
		throw new Error("Invalid native MCP resource blob.");
	}
	return encoded;
}

export function parseNativeSessionMcpResourceRequest(value: unknown): NativeSessionMcpResourceRequest {
	const input = object(value);
	keys(input, ["epoch", "expectedRevision", "serverName", "uri"]);
	return {
		epoch: text(input.epoch, 200), expectedRevision: revision(input.expectedRevision),
		serverName: text(input.serverName, 1024), uri: text(input.uri, 16 * 1024),
	};
}

export function parseNativeSessionMcpResourceResult(value: unknown): NativeSessionMcpResourceResult {
	const input = object(value);
	keys(input, ["contents"]);
	if (!Array.isArray(input.contents) || input.contents.length > 256) throw new Error("Invalid native MCP resource contents.");
	const result: NativeSessionMcpResourceResult = { contents: input.contents.map(raw => {
		const content = object(raw);
		keys(content, ["uri", "mimeType", "text", "blob"]);
		if ((content.text === undefined) === (content.blob === undefined)) throw new Error("Native MCP resource content must contain exactly one data field.");
		return {
			uri: text(content.uri, 16 * 1024),
			...(content.mimeType === undefined ? {} : { mimeType: text(content.mimeType, 1024) }),
			...(content.text === undefined ? { blob: base64(content.blob) } : { text: bodyText(content.text) }),
		};
	}) };
	if (encoder.encode(JSON.stringify(result)).byteLength > MAX_RESULT_BYTES) throw new Error("Native MCP resource result exceeds its 2 MiB limit.");
	return result;
}
