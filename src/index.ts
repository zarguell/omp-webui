import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "./config";
import { getDb } from "./db";
import { buildInjectedEnv } from "./secrets/env";
import { writeCrontab } from "./cron/crontab";
import { listSessions, getSessionFile } from "./sessions/listing";
import { streamSessionFile } from "./sessions/stream";
import { getRpcSession, killAllRpcSessions, spawnOmpRpc } from "./sessions/spawn";
import {
	attachWs,
	createTerminal,
	detachWs,
	getTerminal,
	killAllTerminals,
	killTerminal,
	listTerminals,
} from "./terminals/manager";

const config = getConfig();
const db = getDb(config.dbPath);

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function notFound(msg = "Not found"): Response {
	return json({ error: msg }, 404);
}

function badRequest(msg: string): Response {
	return json({ error: msg }, 400);
}

async function parseJson(req: Request): Promise<Record<string, unknown>> {
	try {
		return (await req.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function getSessionsRoot(): string {
	return path.join(config.agentDir, "sessions");
}

const server = Bun.serve({
	port: config.port,
	hostname: config.bind,
	async fetch(req, server) {
		const url = new URL(req.url);
		const pathname = url.pathname;
		const method = req.method;

		if (pathname === "/api/health") return json({ ok: true });

		if (pathname === "/api/projects" && method === "GET") {
			const rows = db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all();
			return json(rows);
		}
		if (pathname === "/api/projects" && method === "POST") {
			const body = await parseJson(req);
			const name = String(body.name ?? "").trim();
			const cwd = String(body.cwd ?? "").trim();
			if (!name || !cwd) return badRequest("name and cwd required");
			const id = Bun.randomUUIDv7();
			const now = new Date().toISOString();
			try {
				db.prepare("INSERT INTO projects (id, name, cwd, default_model, created_at) VALUES (?, ?, ?, ?, ?)").run(
					id,
					name,
					path.resolve(cwd),
					body.default_model ? String(body.default_model) : null,
					now,
				);
			} catch (e) {
				return badRequest(String(e));
			}
			return json({ id, name, cwd: path.resolve(cwd), default_model: body.default_model ?? null, created_at: now }, 201);
		}
		const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
		if (projectMatch) {
			const id = projectMatch[1];
			if (method === "GET") {
				const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
				if (!row) return notFound();
				return json(row);
			}
			if (method === "PATCH") {
				const body = await parseJson(req);
				const fields: string[] = [];
				const vals: unknown[] = [];
				if (body.name !== undefined) { fields.push("name = ?"); vals.push(String(body.name)); }
				if (body.cwd !== undefined) { fields.push("cwd = ?"); vals.push(path.resolve(String(body.cwd))); }
				if (body.default_model !== undefined) { fields.push("default_model = ?"); vals.push(body.default_model ? String(body.default_model) : null); }
				if (fields.length === 0) return badRequest("nothing to update");
				vals.push(id);
				db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...(vals as never[]));
				return json(db.prepare("SELECT * FROM projects WHERE id = ?").get(id));
			}
			if (method === "DELETE") {
				db.prepare("DELETE FROM projects WHERE id = ?").run(id);
				return json({ ok: true });
			}
		}

		if (pathname === "/api/sessions" && method === "GET") {
			const projectId = url.searchParams.get("projectId");
			let projectCwd: string | undefined;
			if (projectId) {
				const proj = db.prepare("SELECT cwd FROM projects WHERE id = ?").get(projectId) as { cwd: string } | undefined;
				if (proj) projectCwd = proj.cwd;
			}
			return json(listSessions(getSessionsRoot(), projectCwd));
		}
		if (pathname === "/api/sessions" && method === "POST") {
			const body = await parseJson(req);
			const prompt = String(body.prompt ?? "").trim();
			if (!prompt) return badRequest("prompt required");
			const projectId = body.projectId ? String(body.projectId) : null;
			let cwd: string | undefined;
			let model: string | undefined = body.model ? String(body.model) : undefined;
			if (projectId) {
				const proj = db.prepare("SELECT cwd, default_model FROM projects WHERE id = ?").get(projectId) as
					| { cwd: string; default_model: string | null }
					| undefined;
				if (proj) {
					cwd = proj.cwd;
					if (!model && proj.default_model) model = proj.default_model;
				}
			}
			if (body.cwd) cwd = String(body.cwd);
			const sessionId = Bun.randomUUIDv7();
			try {
				await spawnOmpRpc({ db, masterKeyPath: config.masterKeyPath, agentDir: config.agentDir, prompt, cwd, model, sessionId });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
			return json({ sessionId, wsUrl: `/api/sessions/${sessionId}/ws` }, 201);
		}
		const sessionIdMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
		if (sessionIdMatch && method === "GET") {
			const sid = sessionIdMatch[1];
			const file = getSessionFile(getSessionsRoot(), sid);
			if (!file) return notFound("session not found");
			const sessions = listSessions(getSessionsRoot());
			const found = sessions.find(s => s.path === file);
			return json(found ?? { id: sid, path: file });
		}
		const sessionRawMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/raw$/);
		if (sessionRawMatch && method === "GET") {
			const sid = sessionRawMatch[1];
			const file = getSessionFile(getSessionsRoot(), sid);
			if (!file) return notFound();
			return new Response(Bun.file(file));
		}
		const sessionStreamMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
		if (sessionStreamMatch && method === "GET") {
			const sid = sessionStreamMatch[1];
			const file = getSessionFile(getSessionsRoot(), sid);
			if (!file) return notFound();
			let ctrl: ReadableStreamDefaultController<string> | null = null;
			let streamCtrl: ReturnType<typeof streamSessionFile> | null = null;
			const stream = new ReadableStream<string>({
				start(c) {
					ctrl = c;
					const send = (line: string) => {
						try { c.enqueue(`data: ${line}\n\n`); } catch {}
					};
					streamCtrl = streamSessionFile(file, send, err => {
						try { c.enqueue(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`); } catch {}
					});
				},
				cancel() {
					streamCtrl?.close();
				},
			});
			return new Response(stream, {
				headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
			});
		}
		const sessionPromptMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
		if (sessionPromptMatch && method === "POST") {
			const sid = sessionPromptMatch[1];
			const proc = getRpcSession(sid);
			if (!proc) return notFound("no active rpc session");
			const body = await parseJson(req);
			const text = String(body.text ?? body.prompt ?? body.message ?? "");
			if (!text) return badRequest("text required");
			try {
				(proc.stdin as unknown as { write(s: string): void }).write(JSON.stringify({ type: "prompt", message: text }) + "\n");
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
			return json({ ok: true });
		}
		const sessionAbortMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
		if (sessionAbortMatch && method === "POST") {
			const sid = sessionAbortMatch[1];
			const proc = getRpcSession(sid);
			if (!proc) return notFound();
			try {
				(proc.stdin as unknown as { write(s: string): void }).write(JSON.stringify({ type: "abort" }) + "\n");
			} catch {}
			return json({ ok: true });
		}
		const sessionModelMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/model$/);
		if (sessionModelMatch && method === "POST") {
			const sid = sessionModelMatch[1];
			const proc = getRpcSession(sid);
			if (!proc) return notFound();
			const body = await parseJson(req);
			const selector = String(body.selector ?? body.model ?? "");
			if (!selector) return badRequest("selector required");
			const slash = selector.indexOf("/");
			const provider = slash > 0 ? selector.slice(0, slash) : "";
			const modelId = slash > 0 ? selector.slice(slash + 1).split(":")[0] : selector.split(":")[0];
			try {
				(proc.stdin as unknown as { write(s: string): void }).write(
					JSON.stringify(provider ? { type: "set_model", provider, modelId } : { type: "set_model", provider: selector, modelId: "" }) + "\n",
				);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
			return json({ ok: true });
		}
		if (pathname.match(/^\/api\/sessions\/[^/]+\/ws$/)) {
			const sid = pathname.split("/")[3];
			const proc = getRpcSession(sid);
			if (!proc) return notFound("no active rpc session");
			if (server.upgrade(req)) return undefined as unknown as Response;
			return new Response("Upgrade failed", { status: 426 });
		}

		if (pathname === "/api/models" && method === "GET") {
			try {
				const proc = Bun.spawn(["omp", "models", "--json"], { stdout: "pipe", stderr: "pipe", env: buildInjectedEnv(db, config.masterKeyPath, config.agentDir) });
				const text = await new Response(proc.stdout).text();
				await proc.exited;
				try { return json(JSON.parse(text)); } catch { return json({ raw: text }); }
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		}
		if (pathname === "/api/providers" && method === "GET") {
			return json({ hint: "Add provider keys as secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY, etc." });
		}

		if (pathname === "/api/settings" && method === "GET") {
			try {
				const cfgPath = path.join(config.agentDir, "config.yml");
				if (!fs.existsSync(cfgPath)) return json({});
				const { YAML } = await import("bun");
				const raw = YAML.parse(await Bun.file(cfgPath).text());
				return json(raw ?? {});
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		}
		if (pathname === "/api/settings" && method === "PUT") {
			const body = await parseJson(req);
			try {
				const cfgPath = path.join(config.agentDir, "config.yml");
				fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
				const { YAML } = await import("bun");
				let existing: Record<string, unknown> = {};
				if (fs.existsSync(cfgPath)) {
					try { existing = (YAML.parse(await Bun.file(cfgPath).text()) as Record<string, unknown>) ?? {}; } catch {}
				}
				if (body.patch && typeof body.patch === "object") {
					for (const [k, v] of Object.entries(body.patch as Record<string, unknown>)) {
						const parts = k.split(".");
						let cur: Record<string, unknown> = existing;
						for (let i = 0; i < parts.length - 1; i++) {
							if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
							cur = cur[parts[i]] as Record<string, unknown>;
						}
						cur[parts[parts.length - 1]] = v;
					}
				} else if (body.path && body.value !== undefined) {
					const parts = String(body.path).split(".");
					let cur: Record<string, unknown> = existing;
					for (let i = 0; i < parts.length - 1; i++) {
						if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
						cur = cur[parts[i]] as Record<string, unknown>;
					}
					cur[parts[parts.length - 1]] = body.value;
				} else {
					return badRequest("provide { path, value } or { patch }");
				}
				await Bun.write(cfgPath, YAML.stringify(existing));
				return json({ ok: true });
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		}
		if (pathname === "/api/settings/schema" && method === "GET") {
			try {
				const mod = await import("@oh-my-pi/pi-coding-agent/config/settings-schema" as string).catch(() => null);
				if (!mod) return json({ tabs: [], schema: {} });
				return json({ tabs: (mod as { SETTING_TABS?: unknown }).SETTING_TABS ?? [], schema: (mod as { SETTINGS_SCHEMA?: unknown }).SETTINGS_SCHEMA ?? {} });
			} catch {
				return json({ tabs: [], schema: {} });
			}
		}

		if (pathname === "/api/secrets" && method === "GET") {
			const { listSecrets } = await import("./secrets/store");
			return json(listSecrets(db));
		}
		if (pathname === "/api/secrets" && method === "POST") {
			const body = await parseJson(req);
			const name = String(body.name ?? "").trim();
			const value = String(body.value ?? "");
			if (!name || !value) return badRequest("name and value required");
			try {
				const { createSecret } = await import("./secrets/store");
				return json(createSecret(db, config.masterKeyPath, name, value), 201);
			} catch (e) {
				return badRequest(String(e));
			}
		}
		const secretDeleteMatch = pathname.match(/^\/api\/secrets\/([^/]+)$/);
		if (secretDeleteMatch && method === "DELETE") {
			try {
				const { deleteSecret } = await import("./secrets/store");
				deleteSecret(db, secretDeleteMatch[1]);
				return json({ ok: true });
			} catch (e) {
				return notFound(String(e));
			}
		}

		if (pathname === "/api/cron/jobs" && method === "GET") {
			return json(db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all());
		}
		if (pathname === "/api/cron/jobs" && method === "POST") {
			const body = await parseJson(req);
			const name = String(body.name ?? "").trim();
			const cron_expr = String(body.cron ?? body.cron_expr ?? "").trim();
			const prompt = String(body.prompt ?? "").trim();
			if (!name || !cron_expr || !prompt) return badRequest("name, cron, prompt required");
			const { validateCronExpr } = await import("./cron/crontab");
			try { validateCronExpr(cron_expr); } catch (e) { return badRequest(String(e)); }
			const id = Bun.randomUUIDv7();
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO jobs (id, name, cron_expr, prompt, model, project_id, cwd, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).run(id, name, cron_expr, prompt, body.model ? String(body.model) : null, body.projectId ? String(body.projectId) : null, body.cwd ? String(body.cwd) : null, body.enabled === false ? 0 : 1, now, now);
			syncCrontab();
			return json(db.prepare("SELECT * FROM jobs WHERE id = ?").get(id), 201);
		}
		const cronJobMatch = pathname.match(/^\/api\/cron\/jobs\/([^/]+)$/);
		if (cronJobMatch && method === "GET") {
			const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(cronJobMatch[1]);
			if (!row) return notFound();
			return json(row);
		}
		if (cronJobMatch && (method === "PATCH" || method === "PUT")) {
			const body = await parseJson(req);
			const fields: string[] = [];
			const vals: unknown[] = [];
			for (const k of ["name", "cron_expr", "prompt", "model", "project_id", "cwd", "enabled"]) {
				const src = k === "cron_expr" ? (body.cron ?? body.cron_expr) : body[k];
				if (src !== undefined) {
					if (k === "cron_expr" && src) {
						const { validateCronExpr } = await import("./cron/crontab");
						try { validateCronExpr(String(src)); } catch (e) { return badRequest(String(e)); }
					}
					fields.push(`${k} = ?`);
					vals.push(k === "enabled" ? (src ? 1 : 0) : src === null ? null : String(src));
				}
			}
			if (fields.length === 0) return badRequest("nothing to update");
			fields.push("updated_at = ?");
			vals.push(new Date().toISOString());
			vals.push(cronJobMatch[1]);
			db.prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`).run(...(vals as never[]));
			syncCrontab();
			return json(db.prepare("SELECT * FROM jobs WHERE id = ?").get(cronJobMatch[1]));
		}
		if (cronJobMatch && method === "DELETE") {
			db.prepare("DELETE FROM jobs WHERE id = ?").run(cronJobMatch[1]);
			syncCrontab();
			return json({ ok: true });
		}
		const cronTriggerMatch = pathname.match(/^\/api\/cron\/jobs\/([^/]+)\/trigger$/);
		if (cronTriggerMatch && method === "POST") {
			try {
				const { runJob: runCronJob } = await import("./cron/runner");
				const result = await runCronJob(db, config.masterKeyPath, config.agentDir, cronTriggerMatch[1]);
				return json(result);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		}
		if (pathname === "/api/cron/runs" && method === "GET") {
			const jobId = url.searchParams.get("jobId");
			const rows = jobId
				? db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 100").all(jobId)
				: db.prepare("SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 100").all();
			return json(rows);
		}
		const cronRunMatch = pathname.match(/^\/api\/cron\/runs\/([^/]+)$/);
		if (cronRunMatch && method === "GET") {
			const row = db.prepare("SELECT * FROM job_runs WHERE id = ?").get(cronRunMatch[1]);
			if (!row) return notFound();
			return json(row);
		}

		const internalTriggerMatch = pathname.match(/^\/internal\/cron\/trigger\/([^/]+)$/);
		if (internalTriggerMatch && method === "POST") {
			try {
				const { runJob: runCronJob2 } = await import("./cron/runner");
				const result = await runCronJob2(db, config.masterKeyPath, config.agentDir, internalTriggerMatch[1]);
				return json(result);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		}

		if (pathname === "/api/terminals" && method === "GET") return json(listTerminals());
		if (pathname === "/api/terminals" && method === "POST") {
			const body = await parseJson(req);
			try {
				const entry = await createTerminal({
					cwd: body.cwd ? String(body.cwd) : undefined,
					command: body.command ? String(body.command) : undefined,
					cols: body.cols ? Number(body.cols) : undefined,
					rows: body.rows ? Number(body.rows) : undefined,
					env: buildInjectedEnv(db, config.masterKeyPath, config.agentDir),
				});
				return json({ id: entry.id, cwd: entry.cwd, createdAt: entry.createdAt }, 201);
			} catch (e) {
				return badRequest(String(e));
			}
		}
		const termDeleteMatch = pathname.match(/^\/api\/terminals\/([^/]+)$/);
		if (termDeleteMatch && method === "DELETE") {
			killTerminal(termDeleteMatch[1]);
			return json({ ok: true });
		}
		if (pathname.match(/^\/api\/terminals\/[^/]+\/ws$/)) {
			const id = pathname.split("/")[3];
			const entry = getTerminal(id);
			if (!entry) return notFound("terminal not found");
			if (server.upgrade(req)) return undefined as unknown as Response;
			return new Response("Upgrade failed", { status: 426 });
		}

		const distDir = path.join(import.meta.dir, "../dist/web");
		const webFile = pathname === "/" ? "/index.html" : pathname;
		const filePath = path.join(distDir, webFile);
		const file = Bun.file(filePath);
		if (await file.exists()) return new Response(file);
		const indexFile = Bun.file(path.join(distDir, "index.html"));
		if (await indexFile.exists()) return new Response(indexFile);
		return new Response("Not found", { status: 404 });
	},

	websocket: {
		open(ws) {
			(ws as unknown as { data?: unknown }).data = {};
		},
		message(ws, message) {
			const raw = typeof message === "string" ? message : new TextDecoder().decode(message as Uint8Array);
			let parsed: Record<string, unknown>;
			try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = { type: "input", data: raw }; }
			const url = (ws as unknown as { url?: string }).url ?? "";
			if (url.includes("/api/terminals/")) {
				const id = url.split("/")[3];
				const entry = getTerminal(id);
				if (!entry) return;
				if ((ws as unknown as { attached?: boolean }).attached !== true) {
					attachWs(entry, ws as unknown as Bun.ServerWebSocket<unknown>);
					(ws as unknown as { attached: boolean }).attached = true;
					(ws as unknown as { terminalId: string }).terminalId = id;
				}
				if (parsed.type === "input" && typeof parsed.data === "string") {
					try { (entry.subprocess.stdin as unknown as { write(s: string): void }).write(parsed.data); } catch {}
				} else if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
					try { (entry.subprocess as unknown as { resize(c: number, r: number): void }).resize?.(parsed.cols, parsed.rows); } catch {}
				}
				return;
			}
			if (url.includes("/api/sessions/")) {
				const sid = url.split("/")[3];
				const proc = getRpcSession(sid);
				if (!proc) return;
				if (parsed.type === "prompt" && typeof parsed.message === "string") {
					try { (proc.stdin as unknown as { write(s: string): void }).write(JSON.stringify({ type: "prompt", message: parsed.message }) + "\n"); } catch {}
				} else if (parsed.type === "abort") {
					try { (proc.stdin as unknown as { write(s: string): void }).write(JSON.stringify({ type: "abort" }) + "\n"); } catch {}
				}
			}
		},
		close(ws) {
			const id = (ws as unknown as { terminalId?: string }).terminalId;
			if (id) {
				const entry = getTerminal(id);
				if (entry) detachWs(entry, ws as unknown as Bun.ServerWebSocket<unknown>);
			}
		},
	},
});

function syncCrontab(): void {
	try {
		writeCrontab(db, config.crontabPath, config.port, config.bind);
	} catch (e) {
		console.error("writeCrontab failed:", e);
	}
}

syncCrontab();

if (config.bind === "0.0.0.0") {
	console.warn("WARNING: omp-webui bound to 0.0.0.0 — terminal is RCE. Put behind Tailscale/reverse-proxy auth.");
}
console.log(`omp-webui listening on http://${config.bind}:${config.port}  data=${path.dirname(config.dbPath)} agent=${config.agentDir}`);

process.on("SIGINT", () => { killAllRpcSessions(); killAllTerminals(); server.stop(); process.exit(0); });
process.on("SIGTERM", () => { killAllRpcSessions(); killAllTerminals(); server.stop(); process.exit(0); });
