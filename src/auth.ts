import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

/** A validated SAP AI Core service key: the raw JSON plus any embedded resource group. */
export type ValidatedKey = { raw: string; resourceGroup?: string };

// Fields a usable BTP service-key JSON must contain. `serviceurls.AI_API_URL`
// is a dot-path into a nested object.
const REQUIRED_FIELDS = [
	"clientid",
	"clientsecret",
	"url",
	"serviceurls.AI_API_URL",
] as const;

/**
 * Parse and validate a SAP BTP service-key JSON string. Throws an actionable
 * error if it isn't valid JSON or is missing required fields. Returns the raw
 * string alongside any non-standard `resourceGroup` baked into the key.
 *
 * Accepts an optional `resourceGroup` field on the key itself (non-standard but
 * convenient for teams managing multiple groups); `AICORE_RESOURCE_GROUP` still
 * wins at request time (see `resolveResourceGroup` in stream.ts).
 */
export function parseAndValidateServiceKey(raw: string): ValidatedKey {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			"SAP AI Core key must be the full BTP service-key JSON, not a " +
				"plain string. Get it from BTP cockpit → AI Core service " +
				`instance → Service Keys → View. Got: ${raw.slice(0, 40)}...`,
		);
	}

	const missing = REQUIRED_FIELDS.filter((path) => {
		const value = path
			.split(".")
			.reduce<unknown>(
				(acc, segment) =>
					acc && typeof acc === "object" && segment in (acc as object)
						? (acc as Record<string, unknown>)[segment]
						: undefined,
				parsed,
			);
		return typeof value !== "string" || value.length === 0;
	});

	if (missing.length > 0) {
		throw new Error(
			`SAP AI Core service-key JSON is missing required fields: ${missing.join(", ")}. ` +
				"Make sure you pasted the entire service-key object from BTP cockpit.",
		);
	}

	const fromKey =
		typeof (parsed as Record<string, unknown>).resourceGroup === "string"
			? (parsed as Record<string, string>).resourceGroup
			: undefined;
	return { raw, resourceGroup: fromKey };
}

// pi 0.78 runs stored `type:"api_key"` credentials through a $-interpolating
// template engine (resolve-config-value.js), which corrupts any secret
// containing a literal `$` — and SAP service keys carry one in `clientsecret`.
// The `oauth` registration path is pi's escape hatch: a provider's
// `getApiKey()` return value is used verbatim and never passed through that
// engine (auth-storage.js). We aren't doing real OAuth here — `login` just
// captures and validates the pasted service-key JSON and stashes it in the
// persisted credential; `getApiKey` hands it back unchanged.
type SapOAuth = NonNullable<ProviderConfig["oauth"]>;

// Far-future expiry so pi never considers the credential stale and calls
// `refreshToken` (its check is `Date.now() >= expires`, always false here).
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

export const sapAiCoreOAuth: SapOAuth = {
	name: "SAP AI Core",
	async login(callbacks) {
		const raw = (
			await callbacks.onPrompt({
				message:
					"Paste your SAP BTP service-key JSON (single line) for AI Core",
				placeholder: '{ "clientid": "…", "clientsecret": "…", … }',
			})
		).trim();
		// Validate up front so a malformed paste fails at /login, not on first chat.
		parseAndValidateServiceKey(raw);
		// `serviceKey` is a custom field (OAuthCredentials allows extra keys); the
		// required refresh/access/expires fields are stubbed since this isn't a
		// token flow.
		return { serviceKey: raw, access: "", refresh: "", expires: NEVER_EXPIRES };
	},
	getApiKey(credentials) {
		return typeof credentials.serviceKey === "string"
			? credentials.serviceKey
			: "";
	},
	async refreshToken(credentials) {
		// No tokens to refresh; unreachable given NEVER_EXPIRES, but the interface
		// requires it. Return the credential unchanged.
		return credentials;
	},
};
