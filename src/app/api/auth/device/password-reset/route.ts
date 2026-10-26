import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { passwordResetRequestSchema } from "@/lib/validators";
import { allowDeviceLoginAttempt } from "@/lib/auth/rate-limit";
import { readJsonBody } from "@/lib/http/request";
import { requestPasswordReset } from "@/lib/auth/password-reset";
import { getServerTranslator } from "@/lib/i18n/server";

/**
 * The mobile app's "Forgot password": like /api/auth/password-reset/request but,
 * as with device sign-in, guarded by DEVICE_LOGIN_RATE_LIMIT instead of Turnstile.
 * Always 200 once the input is well-formed, so it reveals nothing.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const parsed = passwordResetRequestSchema.safeParse(await readJsonBody(request, 16 * 1024).catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Enter the email address you sign in with" }, { status: 400 });
	if (!(await allowDeviceLoginAttempt(env, request))) {
		return NextResponse.json({ error: "Too many attempts. Try again shortly." }, { status: 429, headers: { "Retry-After": "60" } });
	}
	const origin = env.APP_URL?.trim() || new URL(request.url).origin;
	try {
		await requestPasswordReset(env, parsed.data.email, origin, await getServerTranslator());
	} catch (error) {
		console.error("Password reset request failed", error);
	}
	return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
