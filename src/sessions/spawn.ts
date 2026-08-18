import type { Database } from "bun:sqlite";
import { buildInjectedEnv } from "../secrets/env";

export interface SpawnOptions {
	db: Database;
	masterKeyPath: string;
	agentDir: string;
	prompt: string;
	cwd?: string;
	model?: string;
	sessionDir?: string;
	resumeId?: string;
	timeoutMs?: number;
}

export async function spawnOmpJson(opts: SpawnOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const env = buildInjectedEnv(opts.db, opts.masterKeyPath, opts.agentDir);
	const args = ["--mode", "json", "-p", opts.prompt];
	if (opts.cwd) args.push("--cwd", opts.cwd);
	if (opts.model) args.push("--model", opts.model);
	if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);

	const proc = Bun.spawn(["omp", ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});

	const timeout = opts.timeoutMs
		? setTimeout(() => {
				try {
					proc.kill();
				} catch {}
			}, opts.timeoutMs)
		: null;

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text().catch(() => ""),
		new Response(proc.stderr).text().catch(() => ""),
		proc.exited,
	]);
	if (timeout) clearTimeout(timeout);
	return { exitCode, stdout, stderr };
}

export interface RpcSessionEntry {
	proc: Bun.Subprocess;
	prompt: string;
	cwd?: string;
	model?: string;
	createdAt: string;
	wsClients: Set<Bun.ServerWebSocket<unknown>>;
	buffer: string[];
}

const rpcSessions = new Map<string, RpcSessionEntry>();

function pumpRpcStdout(entry: RpcSessionEntry): void {
	const stream = entry.proc.stdout as ReadableStream<Uint8Array> | null;
	if (!stream) return;
	(async () => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let carry = "";
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			carry += decoder.decode(value, { stream: true });
			const lines = carry.split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				entry.buffer.push(line);
				if (entry.buffer.length > 500) entry.buffer.shift();
				const payload = JSON.stringify({ type: "rpc", data: line });
				for (const ws of entry.wsClients) {
					try {
						ws.send(payload);
					} catch {}
				}
				if (entry.buffer.length === 1 && entry.prompt) {
					try {
						const parsed = JSON.parse(line);
						if (parsed.type === "ready" || line.includes('"type":"ready"')) {
							const promptPayload = JSON.stringify({ type: "prompt", message: entry.prompt });
							try {
								(entry.proc.stdin as unknown as { write(s: string): void }).write(`${promptPayload}\n`);
							} catch {}
						}
					} catch {}
				}
			}
		}
		if (carry.trim()) {
			entry.buffer.push(carry);
			for (const ws of entry.wsClients) {
				try {
					ws.send(JSON.stringify({ type: "rpc", data: carry }));
				} catch {}
			}
		}
	})();
}

export async function spawnOmpRpc(opts: SpawnOptions & { sessionId: string }): Promise<RpcSessionEntry> {
	const env = buildInjectedEnv(opts.db, opts.masterKeyPath, opts.agentDir);
	const args = ["--mode", "rpc"];
	if (opts.resumeId) args.push("--resume", opts.resumeId);
	if (opts.cwd) args.push("--cwd", opts.cwd);
	if (opts.model) args.push("--model", opts.model);
	if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);

	const proc = Bun.spawn(["omp", ...args], {
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const entry: RpcSessionEntry = {
		proc,
		prompt: opts.prompt,
		cwd: opts.cwd,
		model: opts.model,
		createdAt: new Date().toISOString(),
		wsClients: new Set(),
		buffer: [],
	};
	rpcSessions.set(opts.sessionId, entry);
	proc.exited.then(() => {
		for (const ws of entry.wsClients) {
			try {
				ws.send(JSON.stringify({ type: "rpc", data: JSON.stringify({ type: "exit", exitCode: 0 }) }));
			} catch {}
		}
		rpcSessions.delete(opts.sessionId);
	});
	pumpRpcStdout(entry);
	return entry;
}

export function getRpcSession(sessionId: string): RpcSessionEntry | undefined {
	return rpcSessions.get(sessionId);
}

export function attachRpcWs(entry: RpcSessionEntry, ws: Bun.ServerWebSocket<unknown>): void {
	entry.wsClients.add(ws);
	for (const line of entry.buffer) {
		try {
			ws.send(JSON.stringify({ type: "rpc", data: line }));
		} catch {}
	}
}

export function detachRpcWs(entry: RpcSessionEntry, ws: Bun.ServerWebSocket<unknown>): void {
	entry.wsClients.delete(ws);
}

export function listRpcSessions(): { id: string; cwd?: string; model?: string; createdAt: string }[] {
	return [...rpcSessions.entries()].map(([id, e]) => ({ id, cwd: e.cwd, model: e.model, createdAt: e.createdAt }));
}

export function killAllRpcSessions(): void {
	for (const entry of rpcSessions.values()) {
		try {
			entry.proc.kill();
		} catch {}
	}
	rpcSessions.clear();
}
