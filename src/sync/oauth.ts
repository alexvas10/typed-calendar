import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { davRequest } from "./http";

/**
 * OAuth 2.0 sign-in for Google and Microsoft, the way both recommend for a
 * desktop app: the authorization-code flow with PKCE and a loopback redirect.
 *
 * The browser is sent to the provider's sign-in page; after the user
 * approves, it is redirected to a one-shot HTTP server this plugin runs on
 * 127.0.0.1, which receives the code and shuts down. The code is exchanged
 * for tokens with a PKCE verifier, so an intercepted code is useless on its
 * own. The plugin never sees a password.
 *
 * Available because the plugin is desktop-only (node:http, node:crypto).
 */

export interface OAuthConfig {
	/** Shown in errors and on the "you can close this tab" page. */
	label: string;
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	/**
	 * Google's desktop clients have a secret that is not actually secret (it
	 * ships inside every copy of an app) but must still be sent. Microsoft's
	 * public clients have none.
	 */
	clientSecret?: string;
	scopes: string[];
	/** Provider-specific extras, e.g. Google's access_type=offline. */
	authorizeParams?: Record<string, string>;
	/** Microsoft registers "http://localhost", Google accepts 127.0.0.1. */
	redirectHost: "127.0.0.1" | "localhost";
}

export interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds. */
	expiresAt: number;
}

/** How long to wait for the user to finish signing in before giving up. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** Refresh this long before expiry, so a token never lapses mid-sync. */
const EXPIRY_MARGIN_MS = 60_000;

function base64Url(buffer: Buffer): string {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function createPkce(): { verifier: string; challenge: string } {
	const verifier = base64Url(randomBytes(32));
	const challenge = base64Url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

export function buildAuthorizeUrl(
	config: OAuthConfig,
	redirectUri: string,
	challenge: string,
	state: string
): string {
	const url = new URL(config.authorizeUrl);
	const params: Record<string, string> = {
		client_id: config.clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: config.scopes.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		...config.authorizeParams,
	};
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url.toString();
}

/**
 * Reads a token endpoint's JSON. `previousRefresh` covers providers that do
 * not return a new refresh token on every refresh (Google), so the old one
 * stays in use.
 */
export function parseTokenResponse(
	label: string,
	status: number,
	text: string,
	previousRefresh = "",
	now = Date.now()
): OAuthTokens {
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// Fall through to the error below with whatever the server said.
	}
	if (status < 200 || status >= 300 || typeof body.access_token !== "string") {
		const reason = body.error_description ?? body.error ?? text.slice(0, 200);
		throw new Error(`${label} sign-in failed (${status}): ${String(reason)}`);
	}
	const refreshToken =
		typeof body.refresh_token === "string" ? body.refresh_token : previousRefresh;
	if (!refreshToken) {
		// Without one the plugin would have to ask the user to sign in again
		// every hour. Google omits it unless consent is re-prompted.
		throw new Error(`${label} did not return a refresh token. Sign in again.`);
	}
	const expiresIn = Number(body.expires_in ?? 3600);
	return { accessToken: body.access_token, refreshToken, expiresAt: now + expiresIn * 1000 };
}

async function exchange(config: OAuthConfig, fields: Record<string, string>, previousRefresh = "") {
	const form = new URLSearchParams({ client_id: config.clientId, ...fields });
	if (config.clientSecret) form.set("client_secret", config.clientSecret);
	const response = await davRequest({
		url: config.tokenUrl,
		method: "POST",
		body: form.toString(),
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
	});
	return parseTokenResponse(config.label, response.status, response.text, previousRefresh);
}

/** Uses the refresh token for a new access token. */
export function refreshTokens(config: OAuthConfig, tokens: OAuthTokens): Promise<OAuthTokens> {
	return exchange(
		config,
		{ grant_type: "refresh_token", refresh_token: tokens.refreshToken },
		tokens.refreshToken
	);
}

/** True when the access token is missing or about to expire. */
export function needsRefresh(tokens: OAuthTokens, now = Date.now()): boolean {
	return !tokens.accessToken || tokens.expiresAt - EXPIRY_MARGIN_MS <= now;
}

const DONE_PAGE = (label: string, ok: boolean, detail = "") => `<!doctype html>
<meta charset="utf-8"><title>Typed Calendar</title>
<body style="font-family:system-ui,sans-serif;max-width:32em;margin:4em auto;line-height:1.5">
<h2>${ok ? `Signed in to ${label}` : `${label} sign-in did not complete`}</h2>
<p>${ok ? "You can close this tab and return to Obsidian." : detail}</p>
</body>`;

/**
 * Runs the whole sign-in: starts the loopback server, opens the browser,
 * waits for the redirect, and exchanges the code. Rejects on denial, a state
 * mismatch, or the timeout, and always shuts the server down.
 */
export function signIn(
	config: OAuthConfig,
	openBrowser: (url: string) => void
): Promise<OAuthTokens> {
	const { verifier, challenge } = createPkce();
	const state = base64Url(randomBytes(16));

	return new Promise((resolve, reject) => {
		let server: Server | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const finish = (error: Error | null, tokens?: OAuthTokens) => {
			if (timer) clearTimeout(timer);
			server?.close();
			server = null;
			if (error) reject(error);
			else resolve(tokens as OAuthTokens);
		};

		let redirectUri = "";
		server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url ?? "/", redirectUri);
			// Browsers also ask for /favicon.ico; only the redirect matters.
			if (url.pathname !== "/") {
				res.writeHead(404).end();
				return;
			}
			const error = url.searchParams.get("error");
			const code = url.searchParams.get("code");
			const reply = (ok: boolean, detail = "") =>
				res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" })
					.end(DONE_PAGE(config.label, ok, detail));

			if (error) {
				reply(false, `The provider said: ${error}. Return to Obsidian and try again.`);
				finish(new Error(`${config.label} sign-in was not approved (${error}).`));
				return;
			}
			if (!code || url.searchParams.get("state") !== state) {
				reply(false, "The response did not match this sign-in attempt.");
				finish(new Error(`${config.label} sign-in response did not match; try again.`));
				return;
			}
			exchange(config, {
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			}).then(
				(tokens) => {
					reply(true);
					finish(null, tokens);
				},
				(exchangeError: Error) => {
					reply(false, exchangeError.message);
					finish(exchangeError);
				}
			);
		});

		server.on("error", (error) => finish(error));
		// Port 0: the OS picks a free one. Both providers accept any port on a
		// loopback redirect registered without one. Always bound to 127.0.0.1:
		// "localhost" can resolve to the IPv6 address first on some systems, and
		// browsers fall back from ::1 to 127.0.0.1 but a server does not listen
		// on both. Only the address handed to the provider says "localhost".
		server.listen(0, "127.0.0.1", () => {
			const address = server?.address();
			if (!address || typeof address === "string") {
				finish(new Error("Could not start the local sign-in listener."));
				return;
			}
			redirectUri = `http://${config.redirectHost}:${address.port}/`;
			timer = setTimeout(
				() => finish(new Error(`${config.label} sign-in timed out. Try again.`)),
				SIGN_IN_TIMEOUT_MS
			);
			openBrowser(buildAuthorizeUrl(config, redirectUri, challenge, state));
		});
	});
}
