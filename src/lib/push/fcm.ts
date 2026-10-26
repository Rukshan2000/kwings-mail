/**
 * Android push through Firebase Cloud Messaging (HTTP v1). Configured with the
 * `FCM_SERVICE_ACCOUNT` secret: the service-account JSON downloaded from
 * Firebase → Project settings → Service accounts.
 */
type FcmConfig = { projectId: string; clientEmail: string; privateKey: string };

export function fcmConfig(env: CloudflareEnv): FcmConfig | null {
	const raw = env.FCM_SERVICE_ACCOUNT?.trim();
	if (!raw) return null;
	try {
		const json = JSON.parse(raw) as { project_id?: string; client_email?: string; private_key?: string };
		if (!json.project_id || !json.client_email || !json.private_key) return null;
		return { projectId: json.project_id, clientEmail: json.client_email, privateKey: json.private_key };
	} catch {
		return null;
	}
}

function base64Url(bytes: Uint8Array | string): string {
	const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
	let binary = "";
	for (const byte of data) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Google accepts an OAuth access token for an hour; refresh well before. */
let cachedToken: { value: string; clientEmail: string; expiresAt: number } | null = null;

export async function fcmAccessToken(config: FcmConfig, fetchImpl: typeof fetch = fetch): Promise<string> {
	const now = Date.now();
	if (cachedToken && cachedToken.clientEmail === config.clientEmail && cachedToken.expiresAt > now) return cachedToken.value;
	const pem = config.privateKey.replace(/-----[^-]+-----|\s/g, "");
	const der = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
	const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	const iat = Math.floor(now / 1000);
	const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
		JSON.stringify({
			iss: config.clientEmail,
			scope: "https://www.googleapis.com/auth/firebase.messaging",
			aud: "https://oauth2.googleapis.com/token",
			iat,
			exp: iat + 3600,
		}),
	)}`;
	const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
	const response = await fetchImpl("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${base64Url(signature)}` }),
	});
	const data = (await response.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
	if (!response.ok || !data.access_token) throw new Error(`FCM token exchange failed (${response.status}) ${data.error_description ?? ""}`);
	cachedToken = { value: data.access_token, clientEmail: config.clientEmail, expiresAt: now + 45 * 60 * 1000 };
	return data.access_token;
}

export type FcmResult = { kind: "sent" } | { kind: "gone" } | { kind: "failed"; status: number; error: string };

export async function sendFcm(
	config: FcmConfig,
	accessToken: string,
	message: { token: string; title: string; body: string; tag: string; data: Record<string, string> },
	fetchImpl: typeof fetch = fetch,
): Promise<FcmResult> {
	const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`, {
		method: "POST",
		headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
		body: JSON.stringify({
			message: {
				token: message.token,
				notification: { title: message.title, body: message.body },
				data: message.data,
				android: { priority: "high", collapse_key: message.tag, notification: { tag: message.tag } },
			},
		}),
	});
	if (response.ok) return { kind: "sent" };
	const error = ((await response.json().catch(() => ({}))) as { error?: { status?: string; message?: string } }).error;
	// UNREGISTERED: the app was uninstalled or the token rotated.
	if (response.status === 404 || error?.status === "NOT_FOUND" || error?.status === "UNREGISTERED") return { kind: "gone" };
	return { kind: "failed", status: response.status, error: error?.message ?? "" };
}
