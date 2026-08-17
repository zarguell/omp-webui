import * as fs from "node:fs";

export interface StreamController {
	close(): void;
}

export function streamSessionFile(
	sessionPath: string,
	onLine: (line: string) => void,
	onError: (err: Error) => void,
): StreamController {
	let offset = 0;
	let closed = false;
	let watcher: fs.FSWatcher | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	function readIncremental() {
		if (closed) return;
		try {
			const stat = fs.statSync(sessionPath);
			if (stat.size < offset) offset = 0;
			if (stat.size === offset) return;
			const fd = fs.openSync(sessionPath, "r");
			const len = stat.size - offset;
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, offset);
			fs.closeSync(fd);
			offset = stat.size;
			const text = buf.toString("utf8");
			for (const line of text.split("\n")) {
				if (line) onLine(line);
			}
		} catch (err) {
			if (!closed) onError(err instanceof Error ? err : new Error(String(err)));
		}
	}

	try {
		const stat = fs.statSync(sessionPath);
		offset = 0;
		readIncremental();
		if (closed) return { close() {} };

		try {
			watcher = fs.watch(sessionPath, readIncremental);
			watcher.on("error", () => {
				if (!pollTimer && !closed) {
					pollTimer = setInterval(readIncremental, 500);
				}
			});
		} catch {
			pollTimer = setInterval(readIncremental, 500);
		}
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
