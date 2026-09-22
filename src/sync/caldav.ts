import { davRequest, DavResponse } from "./http";

/**
 * A small CalDAV client built on Obsidian's requestUrl.
 *
 * requestUrl is used rather than fetch for two reasons: it is not subject to
 * the renderer's CORS policy (iCloud sends no CORS headers, so fetch cannot
 * talk to it at all), and it passes through the non-standard methods CalDAV
 * depends on. Libraries like tsdav fail here for exactly that reason.
 */

const DAV_NS = "DAV:";
const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";

export interface CalDavCalendar {
	url: string;
	displayName: string;
	/** Opaque token for incremental sync; absent if the server omits it. */
	syncToken?: string;
	color?: string;
	readOnly: boolean;
}

export interface CalDavResource {
	href: string;
	etag: string;
}

export interface CalDavObject extends CalDavResource {
	data: string;
}

export class CalDavError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "CalDavError";
	}
}

export class CalDavClient {
	private readonly auth: string;

	constructor(
		private readonly serverUrl: string,
		username: string,
		password: string
	) {
		// btoa is Latin-1 only; encode first so non-ASCII passwords survive.
		this.auth = `Basic ${btoa(unescape(encodeURIComponent(`${username}:${password}`)))}`;
	}

	/** Walks current-user-principal -> calendar-home-set -> the calendar list. */
	async discoverCalendars(): Promise<CalDavCalendar[]> {
		const principal = await this.findPrincipal();
		const home = await this.findCalendarHome(principal);
		return this.listCalendars(home);
	}

	private async findPrincipal(): Promise<string> {
		const body = xml(`<d:propfind xmlns:d="DAV:">
			<d:prop><d:current-user-principal/></d:prop>
		</d:propfind>`);
		const doc = await this.propfind(this.serverUrl, body, "0");
		const href = firstHref(doc, DAV_NS, "current-user-principal");
		if (!href) throw new CalDavError("Server did not return a user principal.", 0);
		return this.resolve(href);
	}

	private async findCalendarHome(principalUrl: string): Promise<string> {
		const body = xml(`<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV_NS}">
			<d:prop><c:calendar-home-set/></d:prop>
		</d:propfind>`);
		const doc = await this.propfind(principalUrl, body, "0");
		const href = firstHref(doc, CALDAV_NS, "calendar-home-set");
		if (!href) throw new CalDavError("Server did not return a calendar home.", 0);
		return this.resolve(href);
	}

	private async listCalendars(homeUrl: string): Promise<CalDavCalendar[]> {
		const body = xml(`<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV_NS}"
				xmlns:cs="http://calendarserver.org/ns/"
				xmlns:ic="http://apple.com/ns/ical/">
			<d:prop>
				<d:resourcetype/>
				<d:displayname/>
				<d:current-user-privilege-set/>
				<cs:getctag/>
				<d:sync-token/>
				<ic:calendar-color/>
				<c:supported-calendar-component-set/>
			</d:prop>
		</d:propfind>`);
		const doc = await this.propfind(homeUrl, body, "1");

		const calendars: CalDavCalendar[] = [];
		for (const response of Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"))) {
			const href = textOf(response, DAV_NS, "href");
			if (!href) continue;

			const isCalendar =
				response.getElementsByTagNameNS(CALDAV_NS, "calendar").length > 0;
			if (!isCalendar) continue;

			// iCloud exposes contact and reminder collections alongside event
			// ones; keep only collections that actually hold VEVENTs.
			const components = Array.from(
				response.getElementsByTagNameNS(CALDAV_NS, "comp")
			).map((node) => node.getAttribute("name"));
			if (components.length > 0 && !components.includes("VEVENT")) continue;

			const privileges = Array.from(
				response.getElementsByTagNameNS(DAV_NS, "current-user-privilege-set")
			);
			const readOnly =
				privileges.length > 0 &&
				privileges[0].getElementsByTagNameNS(DAV_NS, "write-content").length === 0;

			calendars.push({
				url: this.resolve(href),
				displayName: textOf(response, DAV_NS, "displayname") || decodeURIComponent(href),
				syncToken: textOf(response, DAV_NS, "sync-token") || undefined,
				color: textOf(response, "http://apple.com/ns/ical/", "calendar-color") || undefined,
				readOnly,
			});
		}
		return calendars;
	}

	/** Every resource in a calendar with its ETag, for a full diff. */
	async listResources(calendarUrl: string): Promise<CalDavResource[]> {
		const body = xml(`<d:propfind xmlns:d="DAV:">
			<d:prop><d:getetag/><d:resourcetype/></d:prop>
		</d:propfind>`);
		const doc = await this.propfind(calendarUrl, body, "1");

		const out: CalDavResource[] = [];
		for (const response of Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"))) {
			const href = textOf(response, DAV_NS, "href");
			const etag = textOf(response, DAV_NS, "getetag");
			// The collection itself comes back in the same multistatus; it has
			// no ETag and is not an .ics resource.
			if (!href || !etag || href.endsWith("/")) continue;
			out.push({ href: this.resolve(href), etag });
		}
		return out;
	}

	/** Fetches several resources in one round trip. */
	async multiget(calendarUrl: string, hrefs: string[]): Promise<CalDavObject[]> {
		if (hrefs.length === 0) return [];
		const hrefXml = hrefs.map((href) => `<d:href>${escapeXml(path(href))}</d:href>`).join("");
		const body = xml(`<c:calendar-multiget xmlns:d="DAV:" xmlns:c="${CALDAV_NS}">
			<d:prop><d:getetag/><c:calendar-data/></d:prop>
			${hrefXml}
		</c:calendar-multiget>`);

		const response = await this.request("REPORT", calendarUrl, body, { Depth: "1" });
		const doc = parseMultiStatus(response);

		const out: CalDavObject[] = [];
		for (const node of Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"))) {
			const href = textOf(node, DAV_NS, "href");
			const data = textOf(node, CALDAV_NS, "calendar-data");
			if (!href || !data) continue;
			out.push({ href: this.resolve(href), etag: textOf(node, DAV_NS, "getetag"), data });
		}
		return out;
	}

	/**
	 * Creates or updates a resource. `etag` guards an update against a remote
	 * change; omitting it asserts the resource does not exist yet. A 412 means
	 * the guard failed and the caller should re-read before retrying.
	 */
	async put(url: string, ics: string, etag?: string): Promise<string | undefined> {
		const headers: Record<string, string> = {
			"Content-Type": "text/calendar; charset=utf-8",
		};
		headers[etag ? "If-Match" : "If-None-Match"] = etag ?? "*";

		const response = await this.request("PUT", url, ics, headers);
		if (response.status === 412) {
			throw new CalDavError("Resource changed on the server.", 412);
		}
		if (response.status >= 400) {
			throw new CalDavError(`PUT failed with ${response.status}.`, response.status);
		}
		// Servers may omit the new ETag, in which case the caller re-reads it.
		return response.headers.etag;
	}

	async delete(url: string, etag?: string): Promise<void> {
		const headers: Record<string, string> = etag ? { "If-Match": etag } : {};
		const response = await this.request("DELETE", url, undefined, headers);
		// A missing resource is the state we wanted anyway.
		if (response.status >= 400 && response.status !== 404) {
			throw new CalDavError(`DELETE failed with ${response.status}.`, response.status);
		}
	}

	/** Verifies credentials without mutating anything. */
	async testConnection(): Promise<void> {
		await this.findPrincipal();
	}

	private async propfind(url: string, body: string, depth: string): Promise<Document> {
		const response = await this.request("PROPFIND", url, body, { Depth: depth });
		return parseMultiStatus(response);
	}

	private async request(
		method: string,
		url: string,
		body?: string,
		headers: Record<string, string> = {}
	): Promise<DavResponse> {
		const response = await davRequest({
			url,
			method,
			body,
			headers: {
				Authorization: this.auth,
				"Content-Type": "application/xml; charset=utf-8",
				...headers,
			},
		});

		if (response.status >= 400) {
			console.debug(`Typed Calendar: ${method} ${url} -> ${response.status}`);
		}

		if (response.status === 401 || response.status === 403) {
			throw new CalDavError(
				"iCloud rejected the credentials. Check the Apple ID and app-specific password.",
				response.status
			);
		}
		return response;
	}

	/** Turns a server-relative href into an absolute URL on this server. */
	private resolve(href: string): string {
		try {
			return new URL(href, this.serverUrl).toString();
		} catch {
			return href;
		}
	}
}

function path(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return url;
	}
}

function xml(body: string): string {
	// Collapse indentation to a single space rather than deleting it: these
	// templates wrap attributes across lines, and removing the break entirely
	// would glue two attributes together into malformed XML.
	const collapsed = body.replace(/\s*\n\s*/g, " ").trim();
	return `<?xml version="1.0" encoding="utf-8" ?>${collapsed}`;
}

function escapeXml(value: string): string {
	return value.replace(/[<>&'"]/g, (char) =>
		({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char] ?? char
	);
}

function parseMultiStatus(response: DavResponse): Document {
	if (response.status >= 400) {
		throw new CalDavError(`Request failed with ${response.status}.`, response.status);
	}
	const doc = new DOMParser().parseFromString(response.text, "text/xml");
	if (doc.getElementsByTagName("parsererror").length > 0) {
		throw new CalDavError("Server returned a response that is not valid XML.", response.status);
	}
	return doc;
}

function textOf(scope: Element | Document, ns: string, tag: string): string {
	const node = scope.getElementsByTagNameNS(ns, tag)[0];
	return node?.textContent?.trim() ?? "";
}

function firstHref(scope: Element | Document, ns: string, tag: string): string {
	const node = scope.getElementsByTagNameNS(ns, tag)[0];
	if (!node) return "";
	return node.getElementsByTagNameNS(DAV_NS, "href")[0]?.textContent?.trim() ?? "";
}
