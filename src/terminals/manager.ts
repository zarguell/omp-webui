type TerminalEntry = {
	id: string;
	cwd: string;
	createdAt: string;
	subprocess: Bun.Subprocess;
	buffer: string;
	wsClients: Set<Bun.ServerWebSocket<unknown>>;
};

const MAX_TERMINALS = 10;
const MAX_BUFFER = 64 * 1024;
const IDLE_KILL_MS = 30 * 60_000;
const RECONNECT_WINDOW_MS = 5 * 60_000;

const terminals = new Map<string, TerminalEntry>();
let idleTimer: ReturnType<typeof setInterval> | null = null;

function startIdleReaper(): void {
	if (idleTimer) return;
	idleTimer = setInterval(() => {
		const now = Date.now();
		for (const [id, entry] of terminals) {
			const idle = entry.wsClients.size === 0;
			const age = now - new Date(entry.createdAt).getTime();
			if (idle && age > IDLE_KILL_MS) {
				killTerminal(id);
			}
		}
	}, 60_000);
}

export interface CreateTerminalOptions {
	cwd?: string;
	command?: string;
	cols?: number;
	rows?: number;
	env: Record<string, string>;
}

export async function createTerminal(opts: CreateTerminalOptions): Promise<TerminalEntry> {
	if (terminals.size >= MAX_TERMINALS) {
		throw new Error(`Too many terminals (max ${MAX_TERMINALS}) — kill one first`);
	}
	const id = Bun.randomUUIDv7();
	const cwd = opts.cwd ?? process.cwd();
	const cols = Math.min(Math.max(opts.cols ?? 80, 20), 300);
	const rows = Math.min(Math.max(opts.rows ?? 24, 5), 100);

	const shell = opts.command ?? process.env.SHELL ?? "bash";
	const args = opts.command ? [shell, "-c", opts.command] : [shell, "-l"];

	const subprocess = Bun.spawn([args[0], ...args.slice(1)], {
		cwd,
		env: { ...opts.env, TERM: "xterm-256color", COLUMNS: String(cols), ROWS: String(rows) },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const entry: TerminalEntry = {
		id,
		cwd,
		createdAt: new Date().toISOString(),
		subprocess,
		buffer: "",
		wsClients: new Set(),
	};
	terminals.set(id, entry);
	startIdleReaper();

	const appendBuffer = (chunk: string) => {
		entry.buffer += chunk;
		if (entry.buffer.length > MAX_BUFFER) entry.buffer = entry.buffer.slice(-MAX_BUFFER);
		for (const ws of entry.wsClients) {
			try {
				ws.send(JSON.stringify({ type: "output", data: chunk }));
			} catch {}
		}
	};

	(async () => {
		const reader = async (stream: ReadableStream<Uint8Array> | null) => {
			if (!stream) return;
			const r = stream.getReader();
			const decoder = new TextDecoder();
			while (true) {
				const { value, done } = await r.read();
				if (done) break;
				if (value) appendBuffer(decoder.decode(value, { stream: true }));
			}
		};
		await Promise.all([reader(subprocess.stdout as ReadableStream<Uint8Array>), reader(subprocess.stderr as ReadableStream<Uint8Array>)]);
		const exitCode = await subprocess.exited.catch(() => null);
		for (const ws of entry.wsClients) {
			try {
				ws.send(JSON.stringify({ type: "exit", exitCode }));
			} catch {}
		}
		setTimeout(() => {
			if (terminals.has(id) && entry.wsClients.size === 0) killTerminal(id);
		}, RECONNECT_WINDOW_MS);
	})();

	return entry;
}

export function getTerminal(id: string): TerminalEntry | undefined {
	return terminals.get(id);
}

export function listTerminals(): { id: string; cwd: string; createdAt: string }[] {
	return [...terminals.values()].map(t => ({ id: t.id, cwd: t.cwd, createdAt: t.createdAt }));
}

export function killTerminal(id: string): void {
	const entry = terminals.get(id);
	if (!entry) return;
	try {
		entry.subprocess.kill();
	} catch {}
	terminals.delete(id);
	if (terminals.size === 0 && idleTimer) {
		clearInterval(idleTimer);
		idleTimer = null;
	}
}

export function killAllTerminals(): void {
	for (const id of [...terminals.keys()]) killTerminal(id);
}

export function attachWs(entry: TerminalEntry, ws: Bun.ServerWebSocket<unknown>): void {
	entry.wsClients.add(ws);
	if (entry.buffer) {
		try {
			ws.send(JSON.stringify({ type: "output", data: entry.buffer }));
		} catch {}
	}
}

export function detachWs(entry: TerminalEntry, ws: Bun.ServerWebSocket<unknown>): void {
	entry.wsClients.delete(ws);
}
