import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
	buildAuthorizeUrl, createPkce, needsRefresh, parseTokenResponse, type OAuthConfig,
} from "../src/sync/oauth";

const config: OAuthConfig = {
	label: "Google", authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
	tokenUrl: "https://oauth2.googleapis.com/token", clientId: "abc.apps.googleusercontent.com",
	clientSecret: "shh", scopes: ["https://www.googleapis.com/auth/calendar"],
	authorizeParams: { access_type: "offline", prompt: "consent" }, redirectHost: "127.0.0.1",
};

test("the PKCE challenge is the S256 of the verifier, base64url without padding", () => {
	const { verifier, challenge } = createPkce();
	assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
	const expected = createHash("sha256").update(verifier).digest("base64")
		.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	assert.equal(challenge, expected);
	assert.notEqual(createPkce().verifier, verifier, "every sign-in gets a fresh verifier");
});

test("the sign-in URL carries the code flow, PKCE, state and the provider's extras", () => {
	const url = new URL(buildAuthorizeUrl(config, "http://127.0.0.1:5123/", "CHAL", "STATE"));
	const q = url.searchParams;
	assert.equal(url.origin + url.pathname, config.authorizeUrl);
	assert.equal(q.get("response_type"), "code");
	assert.equal(q.get("redirect_uri"), "http://127.0.0.1:5123/");
	assert.equal(q.get("code_challenge"), "CHAL");
	assert.equal(q.get("code_challenge_method"), "S256");
	assert.equal(q.get("state"), "STATE");
	assert.equal(q.get("scope"), "https://www.googleapis.com/auth/calendar");
	assert.equal(q.get("access_type"), "offline");
	assert.equal(q.get("client_secret"), null, "the secret never goes in a browser URL");
});

test("a token response is read, and an old refresh token kept when none is returned", () => {
	const now = 1_000_000;
	const first = parseTokenResponse("Google", 200,
		JSON.stringify({ access_token: "a1", refresh_token: "r1", expires_in: 3599 }), "", now);
	assert.deepEqual(first, { accessToken: "a1", refreshToken: "r1", expiresAt: now + 3_599_000 });
	const refreshed = parseTokenResponse("Google", 200, JSON.stringify({ access_token: "a2", expires_in: 3599 }), "r1", now);
	assert.equal(refreshed.refreshToken, "r1");
});

test("token errors are reported in the provider's words, and a missing refresh token is refused", () => {
	assert.throws(
		() => parseTokenResponse("Google", 400, JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." })),
		/Google sign-in failed \(400\): Token has been expired or revoked\./
	);
	assert.throws(() => parseTokenResponse("Outlook", 200, JSON.stringify({ access_token: "a" })), /refresh token/);
});

test("a token is refreshed a minute before it expires, not after", () => {
	const tokens = { accessToken: "a", refreshToken: "r", expiresAt: 10 * 60_000 };
	assert.equal(needsRefresh(tokens, 8 * 60_000), false);
	assert.equal(needsRefresh(tokens, 9.5 * 60_000), true);
	assert.equal(needsRefresh({ ...tokens, accessToken: "" }, 0), true);
});
