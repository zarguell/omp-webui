#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
/**
 * Minimal Node.js PTY host — reads JSON commands from stdin, writes events to stdout.
 * Protocol (newline-delimited JSON):
 *   stdin  → { cmd:"spawn", id, shell, args, cwd, env, cols, rows }
 *          → { cmd:"input", id, data }
 *          → { cmd:"resize", id, cols, rows }
 *          → { cmd:"kill", id }
 *   stdout → { id, type:"output", data }
 *          → { id, type:"exit", exitCode }
 *          → { type:"ready" }
 */
import { spawn as ptySpawn } from "node-pty";

function detectShell() {
	if (process.env.SHELL && existsSync(process.env.SHELL))
		return process.env.SHELL;
	try {
		const user = userInfo().username;
		const passwd = readFileSync("/etc/passwd", "utf8");
		for (const line of passwd.split("\n")) {
			const [name, , , , , shellPath] = line.split(":");
			if (name === user && shellPath && existsSync(shellPath)) return shellPath;
		}
	} catch {}
	for (const sh of [
		"/bin/zsh",
		"/usr/bin/zsh",
		"/bin/bash",
		"/usr/bin/bash",
		"/bin/sh",
	]) {
		if (existsSync(sh)) return sh;
	}
	return "/bin/sh";
}

const ptys = new Map();
let buf = "";

process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let nl;
	while ((nl = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (!line) continue;
		try {
			handle(JSON.parse(line));
		} catch {}
	}
});

function send(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function handle(msg) {
	switch (msg.cmd) {
		case "spawn": {
			const shell = msg.shell || detectShell();
			const args = msg.args || (shell.includes("zsh") ? ["-i", "-l"] : ["-i"]);
			const env = { ...msg.env, TERM: "xterm-256color" };
			try {
				const pty = ptySpawn(shell, args, {
					name: "xterm-256color",
					cols: msg.cols || 80,
					rows: msg.rows || 24,
					cwd: msg.cwd || process.cwd(),
					env,
				});
				ptys.set(msg.id, pty);
				pty.onData((data) => send({ id: msg.id, type: "output", data }));
				pty.onExit(({ exitCode }) => {
					send({ id: msg.id, type: "exit", exitCode });
					ptys.delete(msg.id);
				});
			} catch (e) {
				send({ id: msg.id, type: "exit", exitCode: 1, error: e.message });
			}
			break;
		}
		case "input": {
			const pty = ptys.get(msg.id);
			if (pty && typeof msg.data === "string") pty.write(msg.data);
			break;
		}
		case "resize": {
			const pty = ptys.get(msg.id);
			if (pty && msg.cols && msg.rows) {
				try {
					pty.resize(msg.cols, msg.rows);
				} catch {}
			}
			break;
		}
		case "kill": {
			const pty = ptys.get(msg.id);
			if (pty) {
				try {
					pty.kill();
				} catch {}
				ptys.delete(msg.id);
			}
			break;
		}
	}
}

process.on("SIGTERM", () => {
	for (const [, pty] of ptys)
		try {
			pty.kill();
		} catch {}
	process.exit(0);
});
process.on("SIGINT", () => process.exit(0));
