import { OAuthConfig, OAuthTokens, needsRefresh, refreshTokens, signIn } from "./oauth";

/**
 * A signed-in account on an OAuth service: hands out a current access token,
 * refreshing and saving it as needed. Shared by Google and Outlook.
 */
export class OAuthAccount {
	/** One refresh at a time, so parallel requests do not each refresh. */
	private refreshing: Promise<OAuthTokens> | null = null;

	constructor(
		readonly config: OAuthConfig,
		private load: () => OAuthTokens | null,
		private save: (tokens: OAuthTokens | null) => Promise<void>
	) {}

	get signedIn(): boolean {
		return Boolean(this.load()?.refreshToken);
	}

	async signIn(openBrowser: (url: string) => void): Promise<void> {
		await this.save(await signIn(this.config, openBrowser));
	}

	async signOut(): Promise<void> {
		await this.save(null);
	}

	/** A usable access token. `force` refreshes even an unexpired one (after a 401). */
	async token(force = false): Promise<string> {
		const tokens = this.load();
		if (!tokens?.refreshToken) throw new Error(`Sign in to ${this.config.label} in settings first.`);
		if (!force && !needsRefresh(tokens)) return tokens.accessToken;
		if (!this.refreshing) {
			this.refreshing = refreshTokens(this.config, tokens)
				.then(async (fresh) => {
					await this.save(fresh);
					return fresh;
				})
				.finally(() => {
					this.refreshing = null;
				});
		}
		return (await this.refreshing).accessToken;
	}
}

/** Google's endpoints. The client id and secret come from the user's own Google Cloud project for now. */
export function googleOAuth(clientId: string, clientSecret: string): OAuthConfig {
	return {
		label: "Google",
		authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		clientId,
		clientSecret,
		scopes: ["https://www.googleapis.com/auth/calendar"],
		// offline: a refresh token. consent: Google only returns one on consent.
		authorizeParams: { access_type: "offline", prompt: "consent" },
		redirectHost: "127.0.0.1",
	};
}

/** Microsoft's endpoints ("common": personal and work accounts). No secret: a public client. */
export function outlookOAuth(clientId: string): OAuthConfig {
	return {
		label: "Outlook",
		authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
		tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
		clientId,
		scopes: ["offline_access", "Calendars.ReadWrite", "User.Read"],
		authorizeParams: { prompt: "select_account" },
		redirectHost: "localhost",
	};
}
