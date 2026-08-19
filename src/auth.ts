import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Returns the configured password (OMP_WEBUI_PASSWORD) or null when unset.
 * Auth is disabled entirely when this returns null.
 */
export function getAuthPassword(): string | null {
	const raw = process.env.OMP_WEBUI_PASSWORD;
	if (!raw) return null;
	const trimmed = raw.trim();
	return trimmed || null;
}

function sha256(input: string): Buffer {
	return createHash("sha256").update(input, "utf8").digest();
}

function safeEqual(a: string, b: string): boolean {
	const da = sha256(a);
	const db = sha256(b);
	return timingSafeEqual(da, db);
}

/**
 * True when auth is disabled (no password configured), or the request carries
 * valid credentials: `Authorization: Basic <base64(user:pass)>` header or a
 * `?token=<password>` query param (fallback for WS/EventSource contexts).
 */
export function isAuthorized(req: Request): boolean {
	const password = getAuthPassword();
	if (password === null) return true;

	const header = req.headers.get("authorization");
	if (header?.startsWith("Basic ")) {
		try {
			const decoded = atob(header.slice(6).trim());
			const sep = decoded.indexOf(":");
			if (sep >= 0 && safeEqual(decoded.slice(sep + 1), password)) return true;
		} catch {}
	}

	const url = new URL(req.url);
	const token = url.searchParams.get("token");
	if (token !== null && safeEqual(token, password)) return true;

	return false;
}

export function unauthorized(): Response {
	return new Response(JSON.stringify({ error: "unauthorized" }), {
		status: 401,
		headers: {
			"content-type": "application/json",
			"www-authenticate": 'Basic realm="omp-webui", charset="UTF-8"',
		},
	});
}

/** Per-process token required on /internal/cron/trigger/* even when auth is off. */
export function newCronToken(): string {
	return crypto.randomUUID();
}
