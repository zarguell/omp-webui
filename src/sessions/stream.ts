import * as fs from "node:fs";

export interface StreamController {
	close(): void;
}

const MAX_STREAM_LINES = 2000;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;

export async function streamSessionFile(
	sessionPath: string,
	onLine: (line: string) => void,
	onError: (err: Error) => void,
): Promise<StreamController> {
	let offset = 0;
	let closed = false;
	let watcher: fs.FSWatcher | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let carry = "";

	function processChunk(text: string) {
		const combined = carry + text;
		const lines = combined.split("\n");
		carry = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim()) onLine(line);
		}
	}

	function readIncremental() {
		if (closed) return;
		try {
			const stat = fs.statSync(sessionPath);
			if (stat.size < offset) { offset = 0; carry = ""; }
			if (stat.size === offset) return;
			const fd = fs.openSync(sessionPath, "r");
			const len = stat.size - offset;
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, offset);
			fs.closeSync(fd);
			offset = stat.size;
			processChunk(buf.toString("utf8"));
		} catch (err) {
			if (!closed) onError(err instanceof Error ? err : new Error(String(err)));
		}
	}

	try {
		const stat = await fs.promises.stat(sessionPath);
		if (stat.size > MAX_STREAM_BYTES) {
			const fd = await fs.promises.open(sessionPath, "r");
			try {
				const tail = Math.min(stat.size, MAX_STREAM_BYTES);
				const buf = Buffer.alloc(tail);
				await fd.read(buf, 0, tail, stat.size - tail);
				const text = buf.toString("utf8");
				const lines = text.split("\n").filter(Boolean).slice(-MAX_STREAM_LINES);
				for (const line of lines) onLine(line);
			} finally {
				await fd.close();
			}
			offset = stat.size;
		} else {
			offset = 0;
			readIncremental();
		}
		if (closed) return { close() {} };

		// fs.watch + polling fallback (macOS FSEvents is unreliable for appends)
		try {
			watcher = fs.watch(sessionPath, readIncremental);
			watcher.on("error", () => {
				if (!pollTimer && !closed) pollTimer = setInterval(readIncremental, 500);
			});
		} catch {
			pollTimer = setInterval(readIncremental, 500);
		}
		// Always poll as backup
		if (!pollTimer && !closed) pollTimer = setInterval(readIncremental, 1000);
	} catch (err) {
		onError(err instanceof Error ? err : new Error(String(err)));
		return { close() {} };
	}

	return {
		close() {
			closed = true;
			watcher?.close();
			if (pollTimer) clearInterval(pollTimer);
		},
	};
}
