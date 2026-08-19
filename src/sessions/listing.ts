import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionSummary {
	id: string;
	path: string;
	cwd: string;
	title?: string;
	created: string;
	modified: string;
	size: number;
	messageCount: number;
	status?: string;
}

function parseSessionHeader(text: string): { id?: string; cwd?: string; title?: string; timestamp?: string } {
	const lines = text.split("\n");
	for (const line of lines.slice(0, 10)) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line);
			const header = obj.header ?? obj;
			if (header?.type === "session" || header?.id) return header;
		} catch {}
	}
	return {};
}

function deriveStatus(tail: string): string | undefined {
	try {
		const lines = tail.trim().split("\n").filter(Boolean);
		if (lines.length === 0) return undefined;
		const last = JSON.parse(lines[lines.length - 1]);
		const msg = last.message ?? last;
		if (msg?.error) return "error";
		if (msg?.role === "user") return "pending";
		if (last.type === "compaction") return "complete";
		return "complete";
	} catch {
		return undefined;
	}
}

export function listSessions(
	sessionsRoot: string,
	projectCwd?: string,
	opts?: { limit?: number; offset?: number },
): { sessions: SessionSummary[]; total: number } {
	if (!fs.existsSync(sessionsRoot)) return { sessions: [], total: 0 };
	const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 200);
	const offset = Math.max(opts?.offset ?? 0, 0);
	const MAX_FILE_SIZE = 32 * 1024 * 1024;
	const BIG_FILE_WARN = 10 * 1024 * 1024;
	const results: SessionSummary[] = [];
	let scanned = 0;
	let skippedBig = 0;

	function scanDir(dir: string) {
		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith("__advisor")) continue;
			const full = path.join(dir, entry);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(full);
			} catch {
				continue;
			}
			if (stat.isDirectory()) {
				scanDir(full);
			} else if (entry.endsWith(".jsonl")) {
				if (stat.size > MAX_FILE_SIZE) {
					skippedBig++;
					continue;
				}
				if (stat.size > BIG_FILE_WARN) {
					console.warn(
						`Skipping large session ${full} (${(stat.size / 1024 / 1024).toFixed(1)} MB) — use /raw with range`,
					);
				}
				try {
					const head = fs.readFileSync(full, "utf8").slice(0, 4096);
					const tail = (() => {
						try {
							const fd = fs.openSync(full, "r");
							const size = stat.size;
							const tailSize = Math.min(size, 32768);
							const buf = Buffer.alloc(tailSize);
							fs.readSync(fd, buf, 0, tailSize, size - tailSize);
							fs.closeSync(fd);
							return buf.toString("utf8");
						} catch {
							return "";
						}
					})();
					const header = parseSessionHeader(head);
					if (projectCwd && header.cwd && path.resolve(header.cwd) !== path.resolve(projectCwd)) continue;
					const messageCount = tail ? tail.split("\n").filter(Boolean).length : 0;
					results.push({
						id: header.id ?? path.basename(full, ".jsonl"),
						path: full,
						cwd: header.cwd ?? "",
						title: header.title,
						created: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
						modified: new Date(stat.mtimeMs).toISOString(),
						size: stat.size,
						messageCount,
						status: deriveStatus(tail),
					});
					scanned++;
					if (scanned > 5000) return;
				} catch {}
			}
		}
	}

	if (projectCwd) {
		const encoded = encodeSessionDir(projectCwd);
		const projectDir = path.join(sessionsRoot, encoded);
		if (fs.existsSync(projectDir)) scanDir(projectDir);
		for (const p of results) if (!p.cwd) p.cwd = projectCwd;
		if (results.length === 0) scanDir(sessionsRoot);
	} else {
		scanDir(sessionsRoot);
	}

	results.sort((a, b) => b.modified.localeCompare(a.modified));
	if (skippedBig > 0) console.warn(`Skipped ${skippedBig} sessions > ${MAX_FILE_SIZE / 1024 / 1024} MB`);
	const total = results.length;
	return { sessions: results.slice(offset, offset + limit), total };
}

function encodeSessionDir(cwd: string): string {
	const resolved = path.resolve(cwd);
	const home = process.env.HOME ?? "";
	if (home && (resolved === home || resolved.startsWith(`${home}/`))) {
		const rel = path.relative(home, resolved);
		return rel ? `-${rel.replace(/[/\\:]/g, "-")}` : "-";
	}
	const tmp = "/tmp";
	if (resolved === tmp || resolved.startsWith(`${tmp}/`)) {
		const rel = path.relative(tmp, resolved);
		return rel ? `-tmp-${rel.replace(/[/\\:]/g, "-")}` : "-tmp";
	}
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function scanOneLevelForSession(sessionsRoot: string, sessionId: string): string | null {
	function walk(dir: string): string | null {
		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			return null;
		}
		for (const entry of entries) {
			if (entry.startsWith("__advisor")) continue;
			const full = path.join(dir, entry);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(full);
			} catch {
				continue;
			}
			if (stat.isDirectory()) {
				const found = walk(full);
				if (found) return found;
			} else if (entry.endsWith(".jsonl") && entry.includes(sessionId)) {
				return full;
			}
		}
		return null;
	}
	return walk(sessionsRoot);
}

interface CacheEntry {
	path: string;
	expiresAt: number;
}

const SESSION_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const SESSION_CACHE_MAX_SIZE = 500;
const sessionFileCache = new Map<string, CacheEntry>();

function cacheGet(key: string): string | null {
	const entry = sessionFileCache.get(key);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) {
		sessionFileCache.delete(key);
		return null;
	}
	return entry.path;
}

function cacheSet(key: string, filePath: string): void {
	if (sessionFileCache.size >= SESSION_CACHE_MAX_SIZE) {
		const oldest = sessionFileCache.keys().next().value;
		if (oldest !== undefined) sessionFileCache.delete(oldest);
	}
	sessionFileCache.set(key, { path: filePath, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
}

export function getSessionFile(sessionsRoot: string, sessionId: string): string | null {
	const cached = cacheGet(sessionId);
	if (cached) {
		try {
			fs.statSync(cached);
			return cached;
		} catch {
			sessionFileCache.delete(sessionId);
		}
	}
	const direct = scanOneLevelForSession(sessionsRoot, sessionId);
	if (direct) {
		cacheSet(sessionId, direct);
		return direct;
	}
	const all = listSessions(sessionsRoot, undefined, { limit: 200 });
	const found = all.sessions.find(s => s.id === sessionId || s.id.startsWith(sessionId));
	if (found?.path) cacheSet(sessionId, found.path);
	return found?.path ?? null;
}
