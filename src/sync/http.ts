import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

/**
 * Minimal HTTP transport for CalDAV.
 *
 * Obsidian's requestUrl cannot be used here: it downgrades non-standard
 * methods to POST when a body is present, so PROPFIND and REPORT never reach
 * the server (iCloud answers a POST to the calendar root with 400). fetch is
 * not an option either, since iCloud sends no CORS headers and the request is
 * blocked before it leaves the renderer.
 *
 * Node's http(s) module has neither restriction. It is available because this
 * plugin is desktop-only.
 */

export interface DavResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

export interface DavRequestOptions {
	url: string;
	method: string;
	body?: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const MAX_REDIRECTS = 5;

export async function davRequest(options: DavRequestOptions): Promise<DavResponse> {
	return send(options, 0);
}

function send(options: DavRequestOptions, redirects: number): Promise<DavResponse> {
	const { url, method, body, headers = {}, timeoutMs = DEFAULT_TIMEOUT } = options;

	return new Promise((resolve, reject) => {
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			reject(new Error(`Invalid URL: ${url}`));
			return;
		}

		const transport = target.protocol === "http:" ? httpRequest : httpsRequest;
		const payload = body ? Buffer.from(body, "utf8") : undefined;

		const req = transport(
			{
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port || undefined,
				// Query strings matter for some sync-token URLs.
				path: `${target.pathname}${target.search}`,
				method,
				headers: {
					...headers,
					// Length must be the byte count, not the character count,
					// or a non-ASCII event title truncates the request.
					...(payload ? { "Content-Length": String(payload.byteLength) } : {}),
				},
			},
			(res) => {
				const status = res.statusCode ?? 0;

				// iCloud bounces the generic host to a per-account shard.
				if (
					status >= 300 &&
					status < 400 &&
					res.headers.location &&
					redirects < MAX_REDIRECTS
				) {
					res.resume();
					resolve(
						send(
							{ ...options, url: new URL(res.headers.location, target).toString() },
							redirects + 1
						)
					);
					return;
				}

				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const flat: Record<string, string> = {};
					for (const [key, value] of Object.entries(res.headers)) {
						if (value === undefined) continue;
						flat[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
					}
					resolve({
						status,
						headers: flat,
						text: Buffer.concat(chunks).toString("utf8"),
					});
				});
				res.on("error", reject);
			}
		);

		req.setTimeout(timeoutMs, () => {
			req.destroy(new Error(`Request to ${target.host} timed out after ${timeoutMs}ms.`));
		});
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}
