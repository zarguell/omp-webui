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

export function listSessions(sessionsRoot: string, projectCwd?: string): SessionSummary[] {
	if (!fs.existsSync(sessionsRoot)) return [];
	const results: SessionSummary[] = [];

	function scanDir(dir: string) {
		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
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
	return results;
}

function encodeSessionDir(cwd: string): string {
	const resolved = path.resolve(cwd);
	const home = process.env.HOME ?? "";
	if (home && (resolved === home || resolved.startsWith(home + "/"))) {
		const rel = path.relative(home, resolved);
		return rel ? `-${rel.replace(/[/\\:]/g, "-")}` : "-";
	}
	const tmp = "/tmp";
	if (resolved === tmp || resolved.startsWith(tmp + "/")) {
		const rel = path.relative(tmp, resolved);
		return rel ? `-tmp-${rel.replace(/[/\\:]/g, "-")}` : "-tmp";
	}
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function getSessionFile(sessionsRoot: string, sessionId: string): string | null {
	const all = listSessions(sessionsRoot);
	const found = all.find(s => s.id === sessionId || s.id.startsWith(sessionId) || s.path.includes(sessionId));
	return found?.path ?? null;
}
