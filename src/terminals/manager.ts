import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function detectShell(): string {
	// 1. $SHELL env var (set on most systems)
	if (process.env.SHELL && fs.existsSync(process.env.SHELL))
		return process.env.SHELL;
	// 2. /etc/passwd for current user
	try {
		const user = os.userInfo().username;
		const passwd = fs.readFileSync("/etc/passwd", "utf8");
		for (const line of passwd.split("\n")) {
			const [name, , , , , shellPath] = line.split(":");
			if (name === user && shellPath && fs.existsSync(shellPath))
				return shellPath;
		}
	} catch {}
	// 3. Common shells in preference order
	for (const sh of [
		"/bin/zsh",
		"/usr/bin/zsh",
		"/bin/bash",
		"/usr/bin/bash",
		"/bin/sh",
	]) {
		if (fs.existsSync(sh)) return sh;
	}
	return "/bin/sh";
}

type TerminalEntry = {
	id: string;
	cwd: string;
	createdAt: string;
	buffer: string;
	wsClients: Set<Bun.ServerWebSocket<unknown>>;
	cols: number;
	rows: number;
};

const MAX_TERMINALS = 10;
const MAX_BUFFER = 64 * 1024;
const IDLE_KILL_MS = 30 * 60_000;
const RECONNECT_WINDOW_MS = 5 * 60_000;

const terminals = new Map<string, TerminalEntry>();
let idleTimer: ReturnType<typeof setInterval> | null = null;

// ── Node PTY host subprocess ──────────────────────────────────────────
let ptyHost: ReturnType<typeof Bun.spawn> | null = null;
let hostBuf = "";
let hostReady = Promise.withResolvers<void>();
const hostLineHandler: ((msg: Record<string, unknown>) => void)[] = [];

function startPtyHost(): void {
	if (ptyHost) return;
	const hostScript = path.join(import.meta.dir, "pty-host.mjs");
	ptyHost = Bun.spawn(["node", hostScript], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	// Read stdout — newline-delimited JSON
	const reader = async () => {
		if (!ptyHost) return;
		const stream = ptyHost.stdout as ReadableStream<Uint8Array>;
		const r = stream.getReader();
		const decoder = new TextDecoder();
		while (true) {
			const { value, done } = await r.read();
			if (done) break;
			if (!value) continue;
			hostBuf += decoder.decode(value, { stream: true });
			let nl;
			while ((nl = hostBuf.indexOf("\n")) !== -1) {
				const line = hostBuf.slice(0, nl);
				hostBuf = hostBuf.slice(nl + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line) as Record<string, unknown>;
					if (msg.type === "ready") hostReady.resolve();
					for (const handler of hostLineHandler) handler(msg);
				} catch {}
			}
		}
	};
	void reader();

	// Reject pending waits and allow a clean restart if the host dies
	void ptyHost.exited.then((code) => {
		if (!ptyHost) return; // intentional shutdown (killAllTerminals)
		console.error(`pty host exited (code ${code})`);
		ptyHost = null;
		hostBuf = "";
		hostReady.reject(
			new Error(
				`pty host exited (code ${code}) — is node + node-pty installed?`,
			),
		);
		hostReady = Promise.withResolvers<void>();
	});

	// Consume stderr (debug noise)
	const errReader = async () => {
		if (!ptyHost) return;
		const stream = ptyHost.stderr as ReadableStream<Uint8Array>;
		const r = stream.getReader();
		while (true) {
			const { value, done } = await r.read();
			if (done) break;
		}
	};
	void errReader();
}

function hostSend(msg: Record<string, unknown>): void {
	if (!ptyHost) return;
	try {
		(ptyHost.stdin as unknown as { write(s: string): void }).write(
			`${JSON.stringify(msg)}\n`,
		);
	} catch {}
}

// ── Route PTY host output to terminal entries ─────────────────────────
hostLineHandler.push((msg) => {
	const id = msg.id as string;
	if (!id) return;
	const entry = terminals.get(id);
	if (!entry) return;
	if (msg.type === "output" && typeof msg.data === "string") {
		entry.buffer += msg.data;
		if (entry.buffer.length > MAX_BUFFER)
			entry.buffer = entry.buffer.slice(-MAX_BUFFER);
		for (const ws of entry.wsClients) {
			try {
				ws.send(JSON.stringify({ type: "output", data: msg.data }));
			} catch {}
		}
	} else if (msg.type === "exit") {
		const exitCode = msg.exitCode as number | null;
		for (const ws of entry.wsClients) {
			try {
				ws.send(JSON.stringify({ type: "exit", exitCode }));
			} catch {}
		}
		entry.buffer += `\r\n[exit ${exitCode ?? ""}]\r\n`;
		setTimeout(() => {
			if (terminals.has(id) && entry.wsClients.size === 0) killTerminal(id);
		}, RECONNECT_WINDOW_MS);
	}
});

// ── Idle reaper ───────────────────────────────────────────────────────
function startIdleReaper(): void {
	if (idleTimer) return;
	idleTimer = setInterval(() => {
		const now = Date.now();
		for (const [id, entry] of terminals) {
			if (
				now - new Date(entry.createdAt).getTime() > IDLE_KILL_MS &&
				entry.wsClients.size === 0
			) {
				killTerminal(id);
			}
		}
	}, 60_000);
}

// ── Public API ────────────────────────────────────────────────────────
export interface CreateTerminalOptions {
	cwd?: string;
	command?: string;
	cols?: number;
	rows?: number;
	env: Record<string, string>;
}

export async function createTerminal(
	opts: CreateTerminalOptions,
): Promise<TerminalEntry> {
	if (terminals.size >= MAX_TERMINALS)
		throw new Error(
			`Too many terminals (max ${MAX_TERMINALS}) — kill one first`,
		);
	const id = Bun.randomUUIDv7();
	const cwd = opts.cwd ?? process.cwd();
	const cols = Math.min(Math.max(opts.cols ?? 80, 20), 300);
	const rows = Math.min(Math.max(opts.rows ?? 24, 5), 100);

	const entry: TerminalEntry = {
		id,
		cwd,
		createdAt: new Date().toISOString(),
		buffer: "",
		wsClients: new Set(),
		cols,
		rows,
	};
	terminals.set(id, entry);
	startIdleReaper();

	// Start PTY host if needed
	startPtyHost();
	await hostReady.promise;

	const shell = detectShell();
	const args = opts.command
		? [shell.includes("zsh") ? "-l" : "-i", "-c", opts.command]
		: shell.includes("zsh")
			? ["-i", "-l"]
			: shell.includes("fish")
				? []
				: ["-i"];

	if (!opts.command) {
		entry.buffer = `\r\n— shell: ${shell} @ ${cwd} —\r\n`;
	}

	hostSend({ cmd: "spawn", id, shell, args, cwd, env: opts.env, cols, rows });
	return entry;
}

export function getTerminal(id: string): TerminalEntry | undefined {
	return terminals.get(id);
}

export function listTerminals(): {
	id: string;
	cwd: string;
	createdAt: string;
}[] {
	return [...terminals.values()].map((t) => ({
		id: t.id,
		cwd: t.cwd,
		createdAt: t.createdAt,
	}));
}

export function killTerminal(id: string): void {
	const entry = terminals.get(id);
	if (!entry) return;
	hostSend({ cmd: "kill", id });
	terminals.delete(id);
	if (terminals.size === 0 && idleTimer) {
		clearInterval(idleTimer);
		idleTimer = null;
	}
}

export function killAllTerminals(): void {
	for (const id of [...terminals.keys()]) killTerminal(id);
	// Kill the host process and reset state so it can be restarted
	if (ptyHost) {
		try {
			ptyHost.kill();
		} catch {}
		ptyHost = null;
		hostBuf = "";
		hostReady = Promise.withResolvers<void>();
	}
}

export function attachWs(
	entry: TerminalEntry,
	ws: Bun.ServerWebSocket<unknown>,
): void {
	entry.wsClients.add(ws);
	if (entry.buffer) {
		try {
			ws.send(JSON.stringify({ type: "output", data: entry.buffer }));
		} catch {}
	}
}

export function detachWs(
	entry: TerminalEntry,
	ws: Bun.ServerWebSocket<unknown>,
): void {
	entry.wsClients.delete(ws);
}

// Re-export for WS message handler
export function terminalInput(id: string, data: string): void {
	hostSend({ cmd: "input", id, data });
}

export function terminalResize(id: string, cols: number, rows: number): void {
	hostSend({ cmd: "resize", id, cols, rows });
}
