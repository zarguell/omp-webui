import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "./config";
import { writeCrontab } from "./cron/crontab";
import { pruneOldRuns } from "./cron/runner";
import { getDb } from "./db";
import { buildInjectedEnv } from "./secrets/env";
import { getSessionFile, listSessions } from "./sessions/listing";
import { isAuthorized, newCronToken, unauthorized } from "./auth";
import { ensureSessionIndex, querySessions, syncSessionIndex } from "./sessions/index-store";
import {
	getRpcSession,
	killAllRpcSessions,
	spawnOmpRpc,
} from "./sessions/spawn";
import { streamSessionFile } from "./sessions/stream";
import {
	attachWs,
	createTerminal,
	detachWs,
	getTerminal,
	killAllTerminals,
	killTerminal,
	listTerminals,
	terminalInput,
	terminalResize,
} from "./terminals/manager";
import { startWebhookServer } from "./webhooks/server";

const config = getConfig();
const db = getDb(config.dbPath);
const cronToken = newCronToken();

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
	const body = await req.json().catch(() => null);
	return (body && typeof body === "object" ? body : {}) as Record<
		string,
		unknown
	>;
}

function getSessionsRoot(): string {
	return path.join(config.agentDir, "sessions");
}

function newWebhookToken(): string {
	return (
		crypto.randomUUID().replace(/-/g, "") +
		crypto.randomUUID().replace(/-/g, "")
	);
}

function webhookPathFor(job: {
	id: string;
	trigger: string | null;
	webhook_token: string | null;
}): string | null {
	return job.trigger === "webhook" && job.webhook_token
		? `/hook/${job.id}/${job.webhook_token}`
		: null;
}

// Prevent concurrent resume/spawn for the same session ID
const spawningSessions = new Set<string>();

const server = Bun.serve({
	port: config.port,
	hostname: config.bind,
	async fetch(req, server) {
		const url = new URL(req.url);
		const pathname = url.pathname;
		const method = req.method;

		if (pathname === "/api/health") return json({ ok: true });

		// Auth gate — /internal/cron/trigger/* uses the per-process cron token; everything else uses Basic Auth
		if (pathname.startsWith("/internal/cron/trigger/")) {
			if (req.headers.get("x-cron-token") !== cronToken) return unauthorized();
		} else if (!isAuthorized(req)) {
			return unauthorized();
		}

		if (pathname === "/api/projects" && method === "GET") {
			const rows = db
				.prepare("SELECT * FROM projects ORDER BY created_at DESC")
				.all();
			return json(rows);
		}
		if (pathname === "/api/projects" && method === "POST") {
			const body = await parseJson(req);
			const name = String(body.name ?? "").trim();
			const cwd = String(body.cwd ?? "").trim();
			if (!name || !cwd) return badRequest("name and cwd required");
			const approvalMode = body.approval_mode != null ? String(body.approval_mode) : null;
			if (approvalMode && !["always-ask", "write", "yolo"].includes(approvalMode)) {
				return badRequest("approval_mode must be one of: always-ask, write, yolo");
			}
			const id = Bun.randomUUIDv7();
			const now = new Date().toISOString();
			try {
				db.prepare(
					"INSERT INTO projects (id, name, cwd, default_model, approval_mode, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				).run(
					id,
					name,
					path.resolve(cwd),
					body.default_model ? String(body.default_model) : null,
					approvalMode,
					now,
				);
			} catch (e) {
				return badRequest(String(e));
			}
			return json(
				{
					id,
					name,
					cwd: path.resolve(cwd),
					default_model: body.default_model ?? null,
					approval_mode: approvalMode,
					created_at: now,
				},
				201,
			);
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
				if (body.name !== undefined) {
					fields.push("name = ?");
					vals.push(String(body.name));
				}
				if (body.cwd !== undefined) {
					fields.push("cwd = ?");
					vals.push(path.resolve(String(body.cwd)));
				}
				if (body.default_model !== undefined) {
					fields.push("default_model = ?");
					vals.push(body.default_model ? String(body.default_model) : null);
				}
				if (body.approval_mode !== undefined) {
					const am = body.approval_mode != null ? String(body.approval_mode) : null;
					if (am && !["always-ask", "write", "yolo"].includes(am)) {
						return badRequest("approval_mode must be one of: always-ask, write, yolo");
					}
					fields.push("approval_mode = ?");
					vals.push(am);
				}
				if (fields.length === 0) return badRequest("nothing to update");
				vals.push(id);
				db.prepare(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(
					...(vals as never[]),
				);
				return json(db.prepare("SELECT * FROM projects WHERE id = ?").get(id));
			}
			if (method === "DELETE") {
				db.prepare("DELETE FROM projects WHERE id = ?").run(id);
				return json({ ok: true });
			}
		}

		if (pathname === "/api/sessions" && method === "GET") {
			const projectId = url.searchParams.get("projectId");
			const q = url.searchParams.get("q") ?? undefined;
			const statusFilter = url.searchParams.get("status") ?? undefined;
			const limit = Math.min(
				Math.max(Number(url.searchParams.get("limit") ?? 100), 1),
				200,
			);
			const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
			let projectCwd: string | undefined;
			if (projectId) {
				const proj = db
					.prepare("SELECT cwd FROM projects WHERE id = ?")
					.get(projectId) as { cwd: string } | undefined;
				if (proj) projectCwd = proj.cwd;
			}
			try {
				await ensureSessionIndex(db, getSessionsRoot());
				const { sessions, total } = querySessions(db, {
					q,
					cwd: projectCwd,
					status: statusFilter,
					limit,
					offset,
				});
				return json({ sessions, total, limit, offset });
			} catch {
				// Fallback to disk scan
				const { sessions, total } = listSessions(getSessionsRoot(), projectCwd, {
					limit,
					offset,
				});
				return json({ sessions, total, limit, offset });
			}
		}
		if (pathname === "/api/sessions" && method === "POST") {
			const body = await parseJson(req);
			const resumeId = body.resume ? String(body.resume).trim() : null;
			if (resumeId) {
				const existing = getRpcSession(resumeId);
				if (existing) {
					const prompt = String(body.prompt ?? "").trim();
					if (prompt) {
						try {
							(
								existing.proc.stdin as unknown as { write(s: string): void }
							).write(
								`${JSON.stringify({ type: "prompt", message: prompt })}\n`,
							);
						} catch {}
					}
					return json(
						{
							sessionId: resumeId,
							wsUrl: `/api/sessions/${resumeId}/ws`,
							resumed: true,
						},
						201,
					);
				}
				if (spawningSessions.has(resumeId)) {
					return json({ error: "session is already being spawned" }, 409);
				}
				spawningSessions.add(resumeId);
				try {
					const file = getSessionFile(getSessionsRoot(), resumeId);
					if (!file) return notFound("session to resume not found");
					let cwd: string | undefined;
					try {
						const headerText = (await Bun.file(file).text())
							.split("\n")
							.slice(0, 10)
							.join("\n");
						for (const line of headerText.split("\n")) {
							try {
								const obj = JSON.parse(line);
								const h = obj.header ?? obj;
								if (h?.cwd) {
									cwd = h.cwd;
									break;
								}
							} catch {}
						}
					} catch {}
					const prompt = String(body.prompt ?? "").trim();
					let resumeApprovalMode: string | undefined;
					if (cwd) {
						const proj = db
							.prepare("SELECT approval_mode FROM projects WHERE cwd = ?")
							.get(cwd) as { approval_mode: string | null } | undefined;
						resumeApprovalMode = proj?.approval_mode ?? (body.approvalMode ? String(body.approvalMode) : undefined);
					}
					await spawnOmpRpc({
						db,
						masterKeyPath: config.masterKeyPath,
						agentDir: config.agentDir,
						prompt,
						cwd,
						resumeId,
						sessionId: resumeId,
						approvalMode: resumeApprovalMode,
					});
					const rpcAlive = !!getRpcSession(resumeId);
					return json(
						{
							sessionId: resumeId,
							wsUrl: rpcAlive ? `/api/sessions/${resumeId}/ws` : null,
							resumed: true,
							rpcLive: rpcAlive,
						},
						201,
					);
				} catch (e) {
					return json({ error: String(e) }, 500);
				} finally {
					spawningSessions.delete(resumeId);
				}
			}
			const prompt = String(body.prompt ?? "").trim();
			if (!prompt) return badRequest("prompt required");
			const projectId = body.projectId ? String(body.projectId) : null;
			let cwd: string | undefined;
			let model: string | undefined = body.model
				? String(body.model)
				: undefined;
			let approvalMode: string | undefined;
			if (projectId) {
				const proj = db
					.prepare("SELECT cwd, default_model, approval_mode FROM projects WHERE id = ?")
					.get(projectId) as
					| { cwd: string; default_model: string | null; approval_mode: string | null }
					| undefined;
				if (proj) {
					cwd = proj.cwd;
					if (!model && proj.default_model) model = proj.default_model;
					approvalMode = proj.approval_mode ?? (body.approvalMode ? String(body.approvalMode) : undefined);
				}
			}
			if (body.cwd) cwd = String(body.cwd);
			const sessionId = Bun.randomUUIDv7();
			try {
				await spawnOmpRpc({
					db,
					masterKeyPath: config.masterKeyPath,
					agentDir: config.agentDir,
					prompt,
					cwd,
					model,
					sessionId,
					approvalMode,
				});
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
			try {
				const stat = fs.statSync(file);
				if (stat.size > 32 * 1024 * 1024)
					return json(
						{
							id: sid,
							path: file,
							size: stat.size,
							warning: "session too large for summary — use /raw with Range",
						},
						200,
					);
			} catch {}
			const { sessions } = listSessions(getSessionsRoot(), undefined, {
				limit: 200,
			});
			const found = sessions.find((s) => s.path === file);
			return json(found ?? { id: sid, path: file });
		}
		const sessionRawMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/raw$/);
		if (sessionRawMatch && method === "GET") {
			const sid = sessionRawMatch[1];
			const file = getSessionFile(getSessionsRoot(), sid);
			if (!file) return notFound();
			const stat = fs.statSync(file);
			if (stat.size > 5 * 1024 * 1024) {
				const range = req.headers.get("range");
				if (!range) {
					const tail = Math.min(stat.size, 256 * 1024);
					const fd = fs.openSync(file, "r");
					const buf = Buffer.alloc(tail);
					fs.readSync(fd, buf, 0, tail, stat.size - tail);
					fs.closeSync(fd);
					return new Response(buf, {
						headers: {
							"content-type": "application/jsonl",
							"x-truncated": `tail 256KB of ${stat.size}`,
						},
					});
				}
			}
			return new Response(Bun.file(file));
		}
		const sessionStreamMatch = pathname.match(
			/^\/api\/sessions\/([^/]+)\/stream$/,
		);
		if (sessionStreamMatch && method === "GET") {
			const sid = sessionStreamMatch[1];
			let file = getSessionFile(getSessionsRoot(), sid);
			const rpcEntry = getRpcSession(sid);
			if (!file && !rpcEntry) return notFound();
			if (!file && rpcEntry) {
				// Active RPC session — wait briefly for the session file to appear
				for (let i = 0; i < 10; i++) {
					await Bun.sleep(200);
					file = getSessionFile(getSessionsRoot(), sid);
					if (file) break;
				}
				if (!file) return notFound("session file not yet available");
			}
			const afterSeq = Math.max(0, parseInt(url.searchParams.get("afterSeq") ?? "0", 10) || 0);
			let keepAlive: ReturnType<typeof setInterval> | null = null;
			let maxLifetime: ReturnType<typeof setTimeout> | null = null;
			let streamCtrl: { close(): void } | null = null;
			let closed = false;
			const MAX_STREAM_LIFETIME_MS = 30 * 60_000; // 30 minutes
			const cleanup = () => {
				if (closed) return;
				closed = true;
				if (keepAlive) clearInterval(keepAlive);
				if (maxLifetime) clearTimeout(maxLifetime);
				streamCtrl?.close();
			};
			const stream = new ReadableStream<string>({
				start(c) {
					const send = (line: string, seq: number) => {
						try {
							c.enqueue(`id: ${seq}\ndata: ${line}\n\n`);
						} catch {}
					};
					try {
						c.enqueue(`: keepalive\n\n`);
					} catch {}
					keepAlive = setInterval(() => {
						try {
							c.enqueue(`: keepalive\n\n`);
						} catch {}
					}, 15000);
					maxLifetime = setTimeout(() => {
						try {
							c.enqueue(
								`event: heartbeat\ndata: ${JSON.stringify({ type: "max_lifetime_reached" })}\n\n`,
							);
							c.close();
						} catch {}
						cleanup();
					}, MAX_STREAM_LIFETIME_MS);
					void streamSessionFile(file!, send, (err) => {
						if (closed) return;
						try {
							c.enqueue(
								`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`,
							);
						} catch {}
					}, {
						afterLine: afterSeq || undefined,
						onReset: () => {
							if (closed) return;
							try {
								c.enqueue(`event: reset\ndata: ${JSON.stringify({ type: "reset" })}\n\n`);
							} catch {}
						},
					}).then((ctrl) => {
						streamCtrl = ctrl;
					});
				},
				cancel() {
					cleanup();
				},
			});
			return new Response(stream, {
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
					"x-accel-buffering": "no",
				},
			});
		}
		const sessionPromptMatch = pathname.match(
			/^\/api\/sessions\/([^/]+)\/prompt$/,
		);
		if (sessionPromptMatch && method === "POST") {
			const sid = sessionPromptMatch[1];
			const entry = getRpcSession(sid);
			if (!entry) return notFound("no active rpc session");
			const body = await parseJson(req);
			const text = String(body.text ?? body.prompt ?? body.message ?? "");
			if (!text) return badRequest("text required");
			try {
				(entry.proc.stdin as unknown as { write(s: string): void }).write(
					`${JSON.stringify({ type: "prompt", message: text })}\n`,
				);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
			return json({ ok: true });
		}
		const sessionAbortMatch = pathname.match(
			/^\/api\/sessions\/([^/]+)\/abort$/,
		);
		if (sessionAbortMatch && method === "POST") {
			const sid = sessionAbortMatch[1];
			const entry = getRpcSession(sid);
			if (!entry) return notFound();
			try {
				(entry.proc.stdin as unknown as { write(s: string): void }).write(
					`${JSON.stringify({ type: "abort" })}\n`,
				);
			} catch {}
			return json({ ok: true });
		}
		const sessionApprovalMatch = pathname.match(
			/^\/api\/sessions\/([^/]+)\/approval$/,
		);
		if (sessionApprovalMatch && method === "POST") {
			const sid = sessionApprovalMatch[1];
			const entry = getRpcSession(sid);
			if (!entry) return notFound("no active rpc session");
			const body = await parseJson(req);
			const approvalId = String(body.id ?? "");
			if (!approvalId) return badRequest("id required");
			if (
				typeof body.value !== "string" &&
				typeof body.confirmed !== "boolean" &&
				body.cancelled !== true
			) {
				return badRequest("id and one of value/confirmed/cancelled required");
			}
			const response: Record<string, unknown> = {
				type: "extension_ui_response",
				id: approvalId,
			};
			if (typeof body.value === "string") response.value = body.value;
			else if (typeof body.confirmed === "boolean") response.confirmed = body.confirmed;
			else if (body.cancelled === true) response.cancelled = true;
			try {
				(entry.proc.stdin as unknown as { write(s: string): void }).write(
					`${JSON.stringify(response)}\n`,
				);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
			entry.respondedApprovals.add(approvalId);
			entry.pendingApprovals.delete(approvalId);
			return json({ ok: true });
		}
		const sessionModelMatch = pathname.match(
			/^\/api\/sessions\/([^/]+)\/model$/,
		);
		if (sessionModelMatch && method === "GET") {
			const sid = sessionModelMatch[1];
			const file = getSessionFile(getSessionsRoot(), sid);
			if (!file) return notFound();
			try {
				const fd = fs.openSync(file, "r");
				const buf = Buffer.alloc(8192);
				fs.readSync(fd, buf, 0, 8192, 0);
				fs.closeSync(fd);
				const text = buf.toString("utf8");
				let model = "";
				for (const line of text.split("\n")) {
					try {
						const obj = JSON.parse(line);
						if (obj.type === "model_change" && obj.model) model = obj.model;
					} catch {}
				}
				return json({ model: model || null });
			} catch {
				return json({ model: null });
			}
		}
		if (sessionModelMatch && method === "POST") {
			const sid = sessionModelMatch[1];
			const entry = getRpcSession(sid);
			if (!entry) return notFound();
			const body = await parseJson(req);
			const selector = String(body.selector ?? body.model ?? "");
			if (!selector) return badRequest("selector required");
			const slash = selector.indexOf("/");
			const provider = slash > 0 ? selector.slice(0, slash) : "";
			const modelId =
				slash > 0
					? selector.slice(slash + 1).split(":")[0]
					: selector.split(":")[0];
			try {
				(entry.proc.stdin as unknown as { write(s: string): void }).write(
					`${JSON.stringify(provider ? { type: "set_model", provider, modelId } : { type: "set_model", provider: selector, modelId: "" })}\n`,
				);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
			return json({ ok: true });
		}

		if (pathname === "/api/models" && method === "GET") {
			try {
				const proc = Bun.spawn(["omp", "models", "--json"], {
					stdout: "pipe",
					stderr: "pipe",
					env: buildInjectedEnv(db, config.masterKeyPath, config.agentDir),
				});
				const text = await new Response(proc.stdout).text();
				await proc.exited;
				try {
					return json(JSON.parse(text));
				} catch {
					return json({ raw: text });
				}
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		}
		if (pathname === "/api/providers" && method === "GET") {
			const { listSecrets } = await import("./secrets/store");
			const secrets = new Set(listSecrets(db).map((s) => s.name));
			const providers = [
				{
					id: "anthropic",
					env: "ANTHROPIC_API_KEY",
					hasAuth: secrets.has("ANTHROPIC_API_KEY"),
				},
				{
					id: "openai",
					env: "OPENAI_API_KEY",
					hasAuth: secrets.has("OPENAI_API_KEY"),
				},
				{
					id: "openai-codex",
					env: "OPENAI_API_KEY",
					hasAuth: secrets.has("OPENAI_API_KEY"),
				},
				{
					id: "google",
					env: "GEMINI_API_KEY",
					hasAuth:
						secrets.has("GEMINI_API_KEY") || secrets.has("GOOGLE_API_KEY"),
				},
				{
					id: "google-vertex",
					env: "GOOGLE_APPLICATION_CREDENTIALS",
					hasAuth: secrets.has("GOOGLE_APPLICATION_CREDENTIALS"),
				},
				{
					id: "github-copilot",
					env: "GITHUB_TOKEN",
					hasAuth:
						secrets.has("GITHUB_TOKEN") || secrets.has("COPILOT_GITHUB_TOKEN"),
				},
				{ id: "xai", env: "XAI_API_KEY", hasAuth: secrets.has("XAI_API_KEY") },
				{
					id: "groq",
					env: "GROQ_API_KEY",
					hasAuth: secrets.has("GROQ_API_KEY"),
				},
				{
					id: "mistral",
					env: "MISTRAL_API_KEY",
					hasAuth: secrets.has("MISTRAL_API_KEY"),
				},
				{
					id: "deepseek",
					env: "DEEPSEEK_API_KEY",
					hasAuth: secrets.has("DEEPSEEK_API_KEY"),
				},
			];
			return json(providers);
		}

		if (pathname === "/api/settings" && method === "GET") {
			try {
				const cfgPath = path.join(config.agentDir, "config.yml");
				if (!fs.existsSync(cfgPath))
					return json({ webhookPort: config.webhookPort });
				const { YAML } = await import("bun");
				const raw = YAML.parse(await Bun.file(cfgPath).text());
				return json({ ...(raw ?? {}), webhookPort: config.webhookPort });
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
					try {
						existing =
							(YAML.parse(await Bun.file(cfgPath).text()) as Record<
								string,
								unknown
							>) ?? {};
					} catch {}
				}
				if (body.patch && typeof body.patch === "object") {
					for (const [k, v] of Object.entries(
						body.patch as Record<string, unknown>,
					)) {
						const parts = k.split(".");
						let cur: Record<string, unknown> = existing;
						for (let i = 0; i < parts.length - 1; i++) {
							if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null)
								cur[parts[i]] = {};
							cur = cur[parts[i]] as Record<string, unknown>;
						}
						cur[parts[parts.length - 1]] = v;
					}
				} else if (body.path && body.value !== undefined) {
					const parts = String(body.path).split(".");
					let cur: Record<string, unknown> = existing;
					for (let i = 0; i < parts.length - 1; i++) {
						if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null)
							cur[parts[i]] = {};
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
				const mod = await import(
					"@oh-my-pi/pi-coding-agent/config/settings-schema" as string
				).catch(() => null);
				if (!mod) return json({ tabs: [], schema: {} });
				return json({
					tabs: (mod as { SETTING_TABS?: unknown }).SETTING_TABS ?? [],
					schema: (mod as { SETTINGS_SCHEMA?: unknown }).SETTINGS_SCHEMA ?? {},
				});
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
			if (value.length > 8192) return badRequest("value too large (max 8192)");
			if (db.prepare("SELECT 1 FROM secrets").all().length >= 100)
				return badRequest("too many secrets (max 100)");
			try {
				const { createSecret } = await import("./secrets/store");
				return json(createSecret(db, config.masterKeyPath, name, value), 201);
			} catch (e) {
				return badRequest(String(e));
			}
		}
		const secretMatch = pathname.match(/^\/api\/secrets\/([^/]+)$/);
		if (secretMatch && method === "DELETE") {
			try {
				const { deleteSecret } = await import("./secrets/store");
				deleteSecret(db, secretMatch[1]);
				return json({ ok: true });
			} catch (e) {
				return notFound(String(e));
			}
		}
		if (secretMatch && method === "PATCH") {
			const body = await parseJson(req);
			const value = String(body.value ?? "");
			if (!value) return badRequest("value required");
			if (value.length > 8192) return badRequest("value too large (max 8192)");
			try {
				const { updateSecret } = await import("./secrets/store");
				return json(
					updateSecret(db, config.masterKeyPath, secretMatch[1], value),
				);
			} catch (e) {
				return notFound(String(e));
			}
		}

		if (pathname === "/api/cron/jobs" && method === "GET") {
			const rows = db
				.prepare("SELECT * FROM jobs ORDER BY created_at DESC")
				.all() as {
				id: string;
				trigger: string | null;
				webhook_token: string | null;
			}[];
			return json(rows.map((r) => ({ ...r, webhookPath: webhookPathFor(r) })));
		}
		if (pathname === "/api/cron/jobs" && method === "POST") {
			const body = await parseJson(req);
			const name = String(body.name ?? "").trim();
			const cron_expr = String(body.cron ?? body.cron_expr ?? "").trim();
			const prompt = String(body.prompt ?? "").trim();
			const kind = body.kind === "script" ? "script" : "prompt";
			const trigger = body.trigger === "webhook" ? "webhook" : "schedule";
			if (!name) return badRequest("name required");
			if (kind === "script") {
				const scriptSource =
					body.scriptSource === "file"
						? "file"
						: body.scriptSource === "inline"
							? "inline"
							: null;
				if (!scriptSource)
					return badRequest("scriptSource must be 'inline' or 'file'");
				if (typeof body.script !== "string" || !body.script.trim())
					return badRequest("script required");
				if (
					scriptSource === "file" &&
					!fs.existsSync(path.resolve(body.script))
				)
					return badRequest(`script file not found: ${body.script}`);
			} else if (!prompt) {
				return badRequest("prompt required");
			}
			if (
				Array.isArray(body.scriptArgs) &&
				!body.scriptArgs.every((a) => typeof a === "string")
			)
				return badRequest("scriptArgs must be an array of strings");
			if (trigger === "schedule" || cron_expr) {
				if (!cron_expr) return badRequest("cron required for schedule trigger");
				const { validateCronExpr } = await import("./cron/crontab");
				try {
					validateCronExpr(cron_expr);
				} catch (e) {
					return badRequest(String(e));
				}
			}
			const id = Bun.randomUUIDv7();
			const now = new Date().toISOString();
			const webhookToken = trigger === "webhook" ? newWebhookToken() : null;
			db.prepare(
				`INSERT INTO jobs (id, name, cron_expr, prompt, model, project_id, cwd, enabled, created_at, updated_at,
					kind, script_source, script, script_args, "trigger", webhook_token)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				id,
				name,
				cron_expr,
				kind === "script" ? "" : prompt,
				body.model ? String(body.model) : null,
				body.projectId ? String(body.projectId) : null,
				body.cwd ? String(body.cwd) : null,
				body.enabled === false ? 0 : 1,
				now,
				now,
				kind,
				kind === "script"
					? body.scriptSource === "file"
						? "file"
						: "inline"
					: null,
				kind === "script" ? String(body.script) : null,
				kind === "script" && Array.isArray(body.scriptArgs)
					? JSON.stringify(body.scriptArgs)
					: null,
				trigger,
				webhookToken,
			);
			syncCrontab();
			const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as {
				id: string;
				trigger: string | null;
				webhook_token: string | null;
			};
			return json(
				{
					...row,
					webhookPath: webhookPathFor(row),
					webhookToken: webhookToken,
				},
				201,
			);
		}
		const cronJobMatch = pathname.match(/^\/api\/cron\/jobs\/([^/]+)$/);
		if (cronJobMatch && method === "GET") {
			const row = db
				.prepare("SELECT * FROM jobs WHERE id = ?")
				.get(cronJobMatch[1]);
			if (!row) return notFound();
			return json(row);
		}
		if (cronJobMatch && (method === "PATCH" || method === "PUT")) {
			const body = await parseJson(req);
			const jobId = cronJobMatch[1];
			const current = db
				.prepare(`SELECT id, "trigger", cron_expr, kind FROM jobs WHERE id = ?`)
				.get(jobId) as
				| { id: string; trigger: string; cron_expr: string; kind: string }
				| undefined;
			if (!current) return notFound();
			const fields: string[] = [];
			const vals: unknown[] = [];
			const newTrigger =
				body.trigger === "webhook"
					? "webhook"
					: body.trigger === "schedule"
						? "schedule"
						: current.trigger;
			for (const k of [
				"name",
				"cron_expr",
				"prompt",
				"model",
				"project_id",
				"cwd",
				"enabled",
			]) {
				let src = k === "cron_expr" ? (body.cron ?? body.cron_expr) : body[k];
				if (
					k === "cron_expr" &&
					newTrigger === "webhook" &&
					body.trigger !== undefined
				)
					src = "";
				if (src !== undefined) {
					if (k === "cron_expr" && src) {
						const { validateCronExpr } = await import("./cron/crontab");
						try {
							validateCronExpr(String(src));
						} catch (e) {
							return badRequest(String(e));
						}
					}
					fields.push(`${k} = ?`);
					vals.push(
						k === "enabled" ? (src ? 1 : 0) : src === null ? null : String(src),
					);
				}
			}
			if (
				newTrigger === "schedule" &&
				current.trigger === "webhook" &&
				body.trigger !== undefined
			) {
				const effectiveCron = String(
					body.cron ?? body.cron_expr ?? current.cron_expr ?? "",
				).trim();
				if (!effectiveCron)
					return badRequest("cron required when switching to schedule trigger");
			}
			if (body.trigger !== undefined) {
				fields.push(`"trigger" = ?`);
				vals.push(newTrigger);
				if (newTrigger === "webhook" && current.trigger !== "webhook") {
					fields.push("webhook_token = ?");
					vals.push(newWebhookToken());
				}
			}
			if (body.kind !== undefined) {
				const kind = body.kind === "script" ? "script" : "prompt";
				if (kind === "script") {
					const scriptSource =
						body.scriptSource === "file"
							? "file"
							: body.scriptSource === "inline"
								? "inline"
								: null;
					if (!scriptSource)
						return badRequest("scriptSource must be 'inline' or 'file'");
					if (typeof body.script !== "string" || !body.script.trim())
						return badRequest("script required");
					if (
						scriptSource === "file" &&
						!fs.existsSync(path.resolve(body.script))
					)
						return badRequest(`script file not found: ${body.script}`);
				}
				fields.push("kind = ?");
				vals.push(kind);
			}
			if (body.scriptSource !== undefined) {
				if (body.scriptSource !== "inline" && body.scriptSource !== "file")
					return badRequest("scriptSource must be 'inline' or 'file'");
				fields.push("script_source = ?");
				vals.push(String(body.scriptSource));
			}
			if (body.script !== undefined) {
				fields.push("script = ?");
				vals.push(String(body.script));
			}
			if (body.scriptArgs !== undefined) {
				if (
					!Array.isArray(body.scriptArgs) ||
					!body.scriptArgs.every((a) => typeof a === "string")
				)
					return badRequest("scriptArgs must be an array of strings");
				fields.push("script_args = ?");
				vals.push(JSON.stringify(body.scriptArgs));
			}
			if (fields.length === 0) return badRequest("nothing to update");
			fields.push("updated_at = ?");
			vals.push(new Date().toISOString());
			vals.push(jobId);
			db.prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`).run(
				...(vals as never[]),
			);
			syncCrontab();
			const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as {
				id: string;
				trigger: string | null;
				webhook_token: string | null;
			};
			return json({ ...row, webhookPath: webhookPathFor(row) });
		}
		if (cronJobMatch && method === "DELETE") {
			db.prepare("DELETE FROM jobs WHERE id = ?").run(cronJobMatch[1]);
			syncCrontab();
			return json({ ok: true });
		}
		const rotateMatch = pathname.match(
			/^\/api\/cron\/jobs\/([^/]+)\/rotate-token$/,
		);
		if (rotateMatch && method === "POST") {
			const jobId = rotateMatch[1];
			const row = db
				.prepare(`SELECT id, "trigger" FROM jobs WHERE id = ?`)
				.get(jobId) as { id: string; trigger: string | null } | undefined;
			if (!row) return notFound();
			if (row.trigger !== "webhook")
				return badRequest("job is not a webhook job");
			const token = newWebhookToken();
			db.prepare(
				"UPDATE jobs SET webhook_token = ?, updated_at = ? WHERE id = ?",
			).run(token, new Date().toISOString(), jobId);
			return json({
				webhookToken: token,
				webhookPath: `/hook/${jobId}/${token}`,
			});
		}
		const cronTriggerMatch = pathname.match(
			/^\/api\/cron\/jobs\/([^/]+)\/trigger$/,
		);
		if (cronTriggerMatch && method === "POST") {
			try {
				const body = await parseJson(req);
				const { runJob: runCronJob, interpolateTemplate } = await import(
					"./cron/runner"
				);
				const interpolate =
					body.payload !== undefined
						? (p: string) => interpolateTemplate(p, body.payload, {})
						: undefined;
				const result = await runCronJob(
					db,
					config.masterKeyPath,
					config.agentDir,
					cronTriggerMatch[1],
					600_000,
					interpolate,
				);
				return json(result);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		}
		if (pathname === "/api/cron/runs" && method === "GET") {
			const jobId = url.searchParams.get("jobId");
			const rows = jobId
				? db
						.prepare(
							"SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 100",
						)
						.all(jobId)
				: db
						.prepare(
							"SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 100",
						)
						.all();
			return json(rows);
		}
		const cronRunMatch = pathname.match(/^\/api\/cron\/runs\/([^/]+)$/);
		if (cronRunMatch && method === "GET") {
			const row = db
				.prepare("SELECT * FROM job_runs WHERE id = ?")
				.get(cronRunMatch[1]);
			if (!row) return notFound();
			return json(row);
		}

		const internalTriggerMatch = pathname.match(
			/^\/internal\/cron\/trigger\/([^/]+)$/,
		);
		if (internalTriggerMatch && method === "POST") {
			try {
				const { runJob: runCronJob2 } = await import("./cron/runner");
				const result = await runCronJob2(
					db,
					config.masterKeyPath,
					config.agentDir,
					internalTriggerMatch[1],
				);
				return json(result);
			} catch (e) {
				return json({ error: String(e) }, 500);
			}
		}

		if (pathname === "/api/terminals" && method === "GET")
			return json(listTerminals());
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
				return json(
					{ id: entry.id, cwd: entry.cwd, createdAt: entry.createdAt },
					201,
				);
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
			if (
				(
					server as unknown as { upgrade(r: Request, o: unknown): boolean }
				).upgrade(req, { data: { url: req.url } })
			)
				return undefined as unknown as Response;
			return new Response("Upgrade failed", { status: 426 });
		}
		if (pathname.match(/^\/api\/sessions\/[^/]+\/ws$/)) {
			const sid = pathname.split("/")[3];
			const proc = getRpcSession(sid);
			if (!proc) return notFound("no active rpc session");
			if (
				(
					server as unknown as { upgrade(r: Request, o: unknown): boolean }
				).upgrade(req, { data: { url: req.url } })
			)
				return undefined as unknown as Response;
			return new Response("Upgrade failed", { status: 426 });
		}

		const distDir = path.join(import.meta.dir, "../dist/web");
		const normalized = path.normalize(pathname);
		if (normalized.includes(".."))
			return new Response("Not found", { status: 404 });
		const webFile = normalized === "/" ? "/index.html" : normalized;
		const filePath = path.join(distDir, webFile);
		if (
			!filePath.startsWith(distDir + path.sep) &&
			filePath !== path.join(distDir, "index.html")
		)
			return new Response("Not found", { status: 404 });
		const securityHeaders: Record<string, string> = {
			"x-content-type-options": "nosniff",
			"x-frame-options": "DENY",
			"referrer-policy": "strict-origin-when-cross-origin",
		};
		const file = Bun.file(filePath);
		if (await file.exists()) {
			const res = new Response(file);
			for (const [k, v] of Object.entries(securityHeaders))
				res.headers.set(k, v);
			return res;
		}
		const indexFile = Bun.file(path.join(distDir, "index.html"));
		if (await indexFile.exists()) {
			const res = new Response(indexFile);
			for (const [k, v] of Object.entries(securityHeaders))
				res.headers.set(k, v);
			return res;
		}
		return new Response("Not found", { status: 404 });
	},

	websocket: {
		open(ws) {
			const url =
				(ws as unknown as { data?: { url?: string } }).data?.url ?? "";
			const termMatch = url.match(/\/api\/terminals\/([^/]+)\/ws/);
			const sessMatch = url.match(/\/api\/sessions\/([^/]+)\/ws/);
			if (termMatch) {
				const id = termMatch[1];
				const entry = getTerminal(id);
				if (entry) {
					attachWs(entry, ws as unknown as Bun.ServerWebSocket<unknown>);
					(ws as unknown as { attached: boolean }).attached = true;
					(ws as unknown as { terminalId: string }).terminalId = id;
				}
			} else if (sessMatch) {
				const sid = sessMatch[1];
				const entry = getRpcSession(sid);
				if (entry) {
					void import("./sessions/spawn").then(({ attachRpcWs }) => {
						attachRpcWs(entry, ws as unknown as Bun.ServerWebSocket<unknown>);
					});
					(ws as unknown as { attached: boolean }).attached = true;
					(ws as unknown as { rpcSessionId: string }).rpcSessionId = sid;
				}
			}
		},
		async message(ws, message) {
			const raw =
				typeof message === "string"
					? message
					: new TextDecoder().decode(message as Uint8Array);
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				parsed = { type: "input", data: raw };
			}
			const url =
				(ws as unknown as { data?: { url?: string } }).data?.url ?? "";
			const termMatch = url.match(/\/api\/terminals\/([^/]+)\/ws/);
			const sessMatch = url.match(/\/api\/sessions\/([^/]+)\/ws/);
			if (termMatch) {
				const id = termMatch[1];
				const entry = getTerminal(id);
				if (!entry) return;
				if ((ws as unknown as { attached?: boolean }).attached !== true) {
					attachWs(entry, ws as unknown as Bun.ServerWebSocket<unknown>);
					(ws as unknown as { attached: boolean }).attached = true;
					(ws as unknown as { terminalId: string }).terminalId = id;
				}
				if (parsed.type === "input" && typeof parsed.data === "string") {
					terminalInput(id, parsed.data);
				} else if (
					parsed.type === "resize" &&
					typeof parsed.cols === "number" &&
					typeof parsed.rows === "number"
				) {
					terminalResize(id, parsed.cols, parsed.rows);
				}
				return;
			}
			if (sessMatch) {
				const sid = sessMatch[1];
				const entry = getRpcSession(sid);
				if (!entry) return;
				if ((ws as unknown as { attached?: boolean }).attached !== true) {
					const { attachRpcWs } = await import("./sessions/spawn");
					attachRpcWs(entry, ws as unknown as Bun.ServerWebSocket<unknown>);
					(ws as unknown as { attached: boolean }).attached = true;
					(ws as unknown as { rpcSessionId: string }).rpcSessionId = sid;
				}
				if (parsed.type === "prompt" && typeof parsed.message === "string") {
					try {
						(entry.proc.stdin as unknown as { write(s: string): void }).write(
							`${JSON.stringify({ type: "prompt", message: parsed.message })}\n`,
						);
					} catch {}
				} else if (parsed.type === "abort") {
					try {
						(entry.proc.stdin as unknown as { write(s: string): void }).write(
							`${JSON.stringify({ type: "abort" })}\n`,
						);
					} catch {}
				}
			}
		},
		close(ws) {
			const id = (ws as unknown as { terminalId?: string }).terminalId;
			if (id) {
				const entry = getTerminal(id);
				if (entry)
					detachWs(entry, ws as unknown as Bun.ServerWebSocket<unknown>);
			}
			const rpcId = (ws as unknown as { rpcSessionId?: string }).rpcSessionId;
			if (rpcId) {
				const entry = getRpcSession(rpcId);
				if (entry)
					try {
						entry.wsClients.delete(
							ws as unknown as Bun.ServerWebSocket<unknown>,
						);
					} catch {}
			}
		},
	},
});

function syncCrontab(): void {
	try {
		writeCrontab(db, config.crontabPath, config.port, config.bind, cronToken);
	} catch (e) {
		console.error("writeCrontab failed:", e);
	}
}

syncCrontab();

// Session metadata index: immediate + periodic sync
void syncSessionIndex(db, getSessionsRoot()).catch(() => {});
setInterval(() => void syncSessionIndex(db, getSessionsRoot()).catch(() => {}), 60_000);

// Prune old cron run history on startup
try {
	pruneOldRuns(db);
} catch (e) {
	console.error("pruneOldRuns failed:", e);
}

if (config.bind === "0.0.0.0") {
	console.warn(
		"WARNING: omp-webui bound to 0.0.0.0 — terminal is RCE. Put behind Tailscale/reverse-proxy auth.",
	);
}
console.log(
	`omp-webui listening on http://${config.bind}:${config.port}  data=${path.dirname(config.dbPath)} agent=${config.agentDir}`,
);

const webhookServer = startWebhookServer({
	db,
	config,
	masterKeyPath: config.masterKeyPath,
});

process.on("SIGINT", () => {
	killAllRpcSessions();
	killAllTerminals();
	server.stop();
	webhookServer?.stop();
	process.exit(0);
});
process.on("SIGTERM", () => {
	killAllRpcSessions();
	killAllTerminals();
	server.stop();
	webhookServer?.stop();
	process.exit(0);
});
