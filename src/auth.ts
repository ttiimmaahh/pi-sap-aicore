import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthResult,
	Credential,
	OAuthAuth,
	OAuthCredential,
} from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

/** A validated SAP AI Core service key: the raw JSON plus any embedded resource group. */
export type ValidatedKey = { raw: string; resourceGroup?: string };

export const SAP_PROVIDER_ID = "sap-aicore";
export const AICORE_SERVICE_KEY_ENV = "AICORE_SERVICE_KEY";

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

function serviceKeyFromCredential(credential: Credential | undefined): string | undefined {
	if (credential?.type === "api_key") {
		return typeof credential.key === "string" && credential.key.trimStart().startsWith("{")
			? credential.key
			: undefined;
	}
	if (credential?.type !== "oauth") return undefined;
	const serviceKey = credential.serviceKey;
	return typeof serviceKey === "string" && serviceKey.trimStart().startsWith("{")
		? serviceKey
		: undefined;
}

/** Read the primary provider's credential for the foundation provider. */
export function readSharedServiceKeyFromStore(authPath?: string): string | undefined {
	return serviceKeyFromCredential(readStoredCredential(SAP_PROVIDER_ID, authPath));
}

async function promptForServiceKey(
	prompt: (message: string) => Promise<string>,
): Promise<string> {
	const raw = (await prompt("Paste your SAP BTP service-key JSON (single line) for AI Core")).trim();
	parseAndValidateServiceKey(raw);
	return raw;
}

function resolvedServiceKey(raw: string, source: string): AuthResult {
	parseAndValidateServiceKey(raw);
	return { auth: { apiKey: raw }, source };
}

export interface SapApiKeyAuthOptions {
	/** Omit to avoid a second custom credential prompt on the raw foundation provider. */
	login?: boolean;
	/** Read the primary provider's stored credential when this provider has none. */
	readSharedServiceKey?: () => string | undefined;
}

/** Native Pi 0.81 API-key auth; stored JSON is never template-interpolated. */
export function createSapApiKeyAuth(options: SapApiKeyAuthOptions = {}): ApiKeyAuth {
	const login = options.login ?? true;
	return {
		name: "SAP AI Core service key",
		...(login
			? {
					login: async (interaction): Promise<ApiKeyCredential> => ({
						type: "api_key",
						key: await promptForServiceKey((message) =>
							interaction.prompt({
								type: "secret",
								message,
								placeholder: '{ "clientid": "…", "clientsecret": "…", … }',
							}),
						),
					}),
				}
			: {}),
		resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
			if (credential) {
				const stored =
					serviceKeyFromCredential(credential) ?? credential.env?.[AICORE_SERVICE_KEY_ENV];
				if (!stored) {
					throw new Error("Stored SAP AI Core API-key credential does not contain a service key");
				}
				return resolvedServiceKey(stored, "stored SAP AI Core service key");
			}

			const fromEnvironment = await ctx.env(AICORE_SERVICE_KEY_ENV);
			if (fromEnvironment) return resolvedServiceKey(fromEnvironment, AICORE_SERVICE_KEY_ENV);

			const shared = options.readSharedServiceKey?.();
			return shared ? resolvedServiceKey(shared, "shared SAP AI Core credential") : undefined;
		},
	};
}

// Existing releases stored SAP service keys as fake OAuth credentials to avoid
// legacy `$` interpolation. Keep this handler so those credentials continue to
// own and authenticate the provider without forcing users to log in again.
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

export const legacySapServiceKeyOAuth: OAuthAuth = {
	name: "SAP AI Core (legacy credential)",
	loginLabel: "Use the legacy SAP service-key login",
	async login(interaction): Promise<OAuthCredential> {
		const serviceKey = await promptForServiceKey((message) =>
			interaction.prompt({
				type: "secret",
				message,
				placeholder: '{ "clientid": "…", "clientsecret": "…", … }',
			}),
		);
		return {
			type: "oauth",
			serviceKey,
			access: "",
			refresh: "",
			expires: NEVER_EXPIRES,
		};
	},
	async refresh(credential): Promise<OAuthCredential> {
		const serviceKey = serviceKeyFromCredential(credential);
		if (!serviceKey) throw new Error("Stored SAP AI Core credential has no serviceKey field");
		parseAndValidateServiceKey(serviceKey);
		return credential;
	},
	async toAuth(credential): Promise<AuthResult["auth"]> {
		const serviceKey = serviceKeyFromCredential(credential);
		if (!serviceKey) throw new Error("Stored SAP AI Core credential has no serviceKey field");
		return resolvedServiceKey(serviceKey, "legacy SAP AI Core credential").auth;
	},
};
