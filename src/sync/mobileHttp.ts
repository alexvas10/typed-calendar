import { requestUrl } from "obsidian";
import { DavRequestOptions, DavResponse } from "./http";

/**
 * The transport on iPad and iPhone, where Node's http(s) is missing.
 *
 * The phone never syncs (see sync/device.ts), but deleting an event there
 * still has to remove it from iCloud first, or the next sync brings it back.
 * requestUrl handles that and the other standard methods. What it cannot do
 * is send a PROPFIND or REPORT with a body (it turns those into a POST; see
 * sync/http.ts), so those fail here with a clear error instead.
 */

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export async function mobileRequest(options: DavRequestOptions): Promise<DavResponse> {
	const { url, method, body, headers = {} } = options;
	if (body && !BODY_METHODS.has(method.toUpperCase())) {
		throw new Error(`${method} only works on a computer; Obsidian on iPad and iPhone cannot send it.`);
	}

	const response = await requestUrl({ url, method, body, headers, throw: false });
	const flat: Record<string, string> = {};
	for (const [key, value] of Object.entries(response.headers)) flat[key.toLowerCase()] = value;
	return { status: response.status, headers: flat, text: response.text };
}
