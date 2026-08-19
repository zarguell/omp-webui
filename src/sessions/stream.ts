import * as fs from "node:fs";

export interface StreamController {
	close(): void;
}

const MAX_STREAM_LINES = 2000;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;

/**
 * Count newlines in fd[startByte..endByte). Returns the number of complete lines.
 */
function countLines(fd: number, startByte: number, endByte: number): number {
	if (endByte <= startByte) return 0;
	const CHUNK = 256 * 1024;
	let count = 0;
	let pos = startByte;
	while (pos < endByte) {
		const len = Math.min(CHUNK, endByte - pos);
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, pos);
		for (let i = 0; i < len; i++) {
			if (buf[i] === 10) count++; // \n
		}
		pos += len;
	}
	return count;
}

/**
 * Seek past `skipLines` complete newlines from byte 0, returning the byte offset
 * just after the skipLines-th newline, and the absolute sequence number for the
 * next line (skipLines + 1). If the file has fewer lines, returns { offset: size, seq: totalLines + 1 }.
 */
function seekAfterLines(
	fd: number,
	fileSize: number,
	skipLines: number,
): { offset: number; seq: number } {
	const CHUNK = 256 * 1024;
	let linesSeen = 0;
	let pos = 0;
	while (pos < fileSize) {
		const len = Math.min(CHUNK, fileSize - pos);
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, pos);
		for (let i = 0; i < len; i++) {
			if (buf[i] === 10) {
				linesSeen++;
				if (linesSeen >= skipLines) {
					return { offset: pos + i + 1, seq: linesSeen + 1 };
				}
			}
		}
		pos += len;
	}
	// File has fewer lines than skipLines
	return { offset: fileSize, seq: linesSeen + 1 };
}

export async function streamSessionFile(
	sessionPath: string,
	onLine: (line: string, seq: number) => void,
	onError: (err: Error) => void,
	opts?: { afterLine?: number; onReset?: () => void },
): Promise<StreamController> {
	const afterLine = Math.max(0, opts?.afterLine ?? 0);
	let offset = 0;
	let absoluteSeq = 1;
	let closed = false;
	let watcher: fs.FSWatcher | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let carry = "";

	function processChunk(text: string) {
		const combined = carry + text;
		const lines = combined.split("\n");
		carry = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim()) onLine(line, absoluteSeq++);
		}
	}

	function readIncremental() {
		if (closed) return;
		try {
			const stat = fs.statSync(sessionPath);
			if (stat.size < offset) {
				// File truncated — signal reset and restart from beginning
				opts?.onReset?.();
				offset = 0;
				absoluteSeq = 1;
				carry = "";
			}
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

		if (afterLine > 0) {
			// Skip past `afterLine` lines from the start
			const fd = fs.openSync(sessionPath, "r");
			const { offset: seeked, seq } = seekAfterLines(fd, stat.size, afterLine);
			fs.closeSync(fd);
			offset = seeked;
			absoluteSeq = seq;
		} else if (stat.size > MAX_STREAM_BYTES) {
			// Oversized file: tail the last MAX_STREAM_LINES and signal reset
			opts?.onReset?.();
			const tail = Math.min(stat.size, MAX_STREAM_BYTES);
			const countFd = fs.openSync(sessionPath, "r");
			const linesBefore = countLines(countFd, 0, stat.size - tail);
			fs.closeSync(countFd);

			const readFd = await fs.promises.open(sessionPath, "r");
			try {
				const buf = Buffer.alloc(tail);
				await readFd.read(buf, 0, tail, stat.size - tail);
				const text = buf.toString("utf8");
				const tailLines = text.split("\n").filter(Boolean).slice(-MAX_STREAM_LINES);

				absoluteSeq = linesBefore + 1;
				for (const line of tailLines) onLine(line, absoluteSeq++);
			} finally {
				await readFd.close();
			}
			offset = stat.size;
		} else {
			offset = 0;
			absoluteSeq = 1;
			readIncremental();
		}
		if (closed) return { close() {} };

		// fs.watch + polling fallback (macOS FSEvents is unreliable for appends)
		try {
			watcher = fs.watch(sessionPath, readIncremental);
			watcher.on("error", () => {
				if (!pollTimer && !closed)
					pollTimer = setInterval(readIncremental, 500);
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
