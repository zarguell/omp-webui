import type { Database } from "bun:sqlite";
import { scanAllSessions } from "./listing";

let lastSyncAt = 0;

export function getLastSyncAt(): number {
	return lastSyncAt;
}

/**
 * Scan all sessions on disk and upsert into the sessions table.
 * Deletes rows for files that no longer exist.
 */
export async function syncSessionIndex(
	db: Database,
	sessionsRoot: string,
): Promise<void> {
	const startedAt = new Date().toISOString();
	const all = scanAllSessions(sessionsRoot);

	db.transaction(() => {
		// Remove rows for deleted files
		db.prepare("DELETE FROM sessions WHERE indexed_at < ?").run(startedAt);

		const upsert = db.prepare(`
			INSERT INTO sessions (id, path, cwd, title, status, message_count, size, modified, indexed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				path = excluded.path,
				cwd = excluded.cwd,
				title = excluded.title,
				status = excluded.status,
				message_count = excluded.message_count,
				size = excluded.size,
				modified = excluded.modified,
				indexed_at = excluded.indexed_at
		`);

		for (const s of all) {
			upsert.run(
				s.id,
				s.path,
				s.cwd,
				s.title ?? null,
				s.status ?? null,
				s.messageCount,
				s.size,
				s.modified,
				startedAt,
			);
		}
	})();

	lastSyncAt = Date.now();
}

/**
 * Ensure the session index is fresh (within 30s). Falls back to disk scan on error.
 */
export async function ensureSessionIndex(
	db: Database,
	sessionsRoot: string,
): Promise<void> {
	if (Date.now() - lastSyncAt < 30_000) return;
	try {
		await syncSessionIndex(db, sessionsRoot);
	} catch {
		// Fall through — callers will use listSessions as fallback
	}
}

export function querySessions(
	db: Database,
	opts: { q?: string; cwd?: string; status?: string; limit: number; offset: number },
): { sessions: Record<string, unknown>[]; total: number } {
	const where: string[] = [];
	const params: string[] = [];

	if (opts.q) {
		where.push("(title LIKE '%' || ? || '%' OR cwd LIKE '%' || ? || '%' OR id LIKE '%' || ? || '%')");
		params.push(opts.q, opts.q, opts.q);
	}
	if (opts.cwd) {
		where.push("cwd = ?");
		params.push(opts.cwd);
	}
	if (opts.status) {
		where.push("status = ?");
		params.push(opts.status);
	}

	const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

	const totalRow = db
		.prepare(`SELECT COUNT(*) as cnt FROM sessions ${whereClause}`)
		.get(...params) as { cnt: number };

	const sessions = db
		.prepare(
			`SELECT * FROM sessions ${whereClause} ORDER BY modified DESC LIMIT ? OFFSET ?`,
		)
		.all(...params, opts.limit, opts.offset) as Record<string, unknown>[];

	return { sessions, total: totalRow.cnt };
}
