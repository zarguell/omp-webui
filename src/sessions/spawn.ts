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
	timeoutMs?: number;
}

export async function spawnOmpJson(
	opts: SpawnOptions,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

const rpcSessions = new Map<string, Bun.Subprocess>();

export async function spawnOmpRpc(opts: SpawnOptions & { sessionId: string }): Promise<Bun.Subprocess> {
	const env = buildInjectedEnv(opts.db, opts.masterKeyPath, opts.agentDir);
	const args = ["--mode", "rpc"];
	if (opts.cwd) args.push("--cwd", opts.cwd);
	if (opts.model) args.push("--model", opts.model);
	if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);

	const proc = Bun.spawn(["omp", ...args], {
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	rpcSessions.set(opts.sessionId, proc);
	proc.exited.then(() => rpcSessions.delete(opts.sessionId));
	return proc;
}

export function getRpcSession(sessionId: string): Bun.Subprocess | undefined {
	return rpcSessions.get(sessionId);
}

export function killAllRpcSessions(): void {
	for (const proc of rpcSessions.values()) {
		try {
			proc.kill();
		} catch {}
	}
	rpcSessions.clear();
}
