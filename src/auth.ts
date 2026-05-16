import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";

const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

type ServiceKey = {
	clientid: string;
	clientsecret: string;
	url: string;
	serviceurls: { AI_API_URL: string };
};

function validateServiceKey(raw: string): ServiceKey {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`Not valid JSON: ${(error as Error).message}. ` +
				"Paste the BTP service-key JSON as a single line.",
		);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error("Service key must be a JSON object");
	}

	const key = parsed as Record<string, unknown>;
	const missing: string[] = [];
	if (typeof key.clientid !== "string") missing.push("clientid");
	if (typeof key.clientsecret !== "string") missing.push("clientsecret");
	if (typeof key.url !== "string") missing.push("url");

	const urls = key.serviceurls as Record<string, unknown> | undefined;
	if (!urls || typeof urls !== "object" || typeof urls.AI_API_URL !== "string") {
		missing.push("serviceurls.AI_API_URL");
	}

	if (missing.length > 0) {
		throw new Error(
			`Service key is missing required fields: ${missing.join(", ")}`,
		);
	}

	return parsed as ServiceKey;
}

export async function loginSapAiCore(
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	const raw = await callbacks.onPrompt({
		message:
			"Paste your SAP BTP AI Core service-key JSON (single line, from BTP cockpit → Service Key → View):",
	});

	const trimmed = raw.trim();
	validateServiceKey(trimmed);

	return {
		refresh: "",
		access: trimmed,
		expires: NEVER_EXPIRES,
	};
}

export async function refreshSapAiCore(
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	return credentials;
}

export function getSapAiCoreApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}
