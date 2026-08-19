import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ModelSelect } from "../components/model-select";
import { apiGet, apiPost } from "../lib/api";

type Session = {
	id: string;
	path: string;
	cwd: string;
	title?: string;
	modified: string;
	status?: string;
	size: number;
	messageCount: number;
};
type Project = { id: string; name: string; cwd: string };

function renderLine(
	line: string,
): { role: "user" | "assistant" | "system"; text: string } | null {
	try {
		const obj = JSON.parse(line);
		const entry = obj.entry ?? obj;
		const msg = entry.message ?? entry;
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (
					part.type === "text" &&
					typeof part.text === "string" &&
					part.text.trim()
				)
					return { role: "assistant", text: part.text };
				if (part.type === "toolCall" && part.arguments?.command)
					return { role: "assistant", text: `$ ${part.arguments.command}` };
				if (part.type === "toolCall" && part.name)
					return { role: "assistant", text: `→ ${part.name}` };
			}
		}
		if (msg?.role === "toolResult" && Array.isArray(msg.content)) {
			const text = msg.content
				.filter((c: { type: string }) => c.type === "text")
				.map((c: { text: string }) => c.text)
				.join("\n");
			if (text) {
				const preview = text.split("\n").slice(0, 8).join("\n");
				return {
					role: "assistant",
					text: preview + (text.split("\n").length > 8 ? "\n…" : ""),
				};
			}
		}
		if (msg?.role === "user" && typeof msg.content === "string")
			return { role: "user", text: msg.content };
		if (Array.isArray(msg?.content)) {
			const text = msg.content
				.filter((c: { type: string }) => c.type === "text")
				.map((c: { text: string }) => c.text)
				.join("\n");
			if (text)
				return { role: msg.role === "user" ? "user" : "assistant", text };
		}
		if (
			entry.type === "compaction" ||
			entry.type === "session_exit" ||
			entry.type === "session"
		)
			return null;
		if (
			msg?.content === "" ||
			(Array.isArray(msg?.content) && msg.content.length === 0)
		)
			return null;
		if (entry.customType === "tool_execution_start") {
			const d = entry.data as {
				toolName?: string;
				args?: { command?: string };
			};
			if (d?.args?.command)
				return {
					role: "system",
					text: `$ ${String(d.args.command).slice(0, 120)}`,
				};
			if (d?.toolName) return { role: "system", text: `→ ${d.toolName}` };
			return null;
		}
		if (typeof msg?.content === "string" && msg.content.trim())
			return { role: msg.role ?? "assistant", text: msg.content };
		return null;
	} catch {
		return null;
	}
}

export function SessionsPage({
	onOpenChat,
}: {
	onOpenChat?: (id: string) => void;
}): React.ReactElement {
	const [sessions, setSessions] = useState<Session[]>([]);
	const [projects, setProjects] = useState<Project[]>([]);
	const [loading, setLoading] = useState(true);
	const [err, setErr] = useState("");
	const [q, setQ] = useState("");
	const [prompt, setPrompt] = useState("");
	const [projectId, setProjectId] = useState("");
	const [model, setModel] = useState("");
	const [streamId, setStreamId] = useState<string | null>(null);
	const [lines, setLines] = useState<string[]>([]);
	const [followUp, setFollowUp] = useState("");
	const [rpcStatus, setRpcStatus] = useState<
		"idle" | "connecting" | "live" | "closed"
	>("idle");
	const streamRef = useRef<HTMLDivElement>(null);
	const rpcRef = useRef<WebSocket | null>(null);
	const pageSize = 20;
	const [page, setPage] = useState(0);

	const refresh = async (silent = false) => {
		if (!silent) setLoading(true);
		setErr("");
		try {
			const [s, p] = await Promise.all([
				apiGet("/api/sessions?limit=100"),
				apiGet("/api/projects").catch(() => []),
			]);
			const sess = Array.isArray(s)
				? (s as Session[])
				: ((s as { sessions: Session[] }).sessions ?? []);
			setSessions(sess);
			setProjects((p as Project[]) ?? []);
		} catch (e) {
			setErr(String(e));
		} finally {
			setLoading(false);
		}
	};
	useEffect(() => {
		void refresh();
	}, []);
	useEffect(() => {
		if (streamRef.current)
			streamRef.current.scrollTop = streamRef.current.scrollHeight;
	}, []);

	const filtered = useMemo(() => {
		const query = q.toLowerCase();
		let list = sessions;
		if (query)
			list = list.filter((s) =>
				`${s.title ?? ""} ${s.cwd} ${s.id}`.toLowerCase().includes(query),
			);
		return list;
	}, [sessions, q]);
	const paged = filtered.slice(page * pageSize, (page + 1) * pageSize);
	const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

	const create = async () => {
		if (!prompt.trim()) return;
		const p = prompt;
		setPrompt("");
		try {
			const res = (await apiPost("/api/sessions", {
				prompt: p,
				projectId: projectId || undefined,
				model: model || undefined,
			})) as { sessionId: string };
			setStreamId(res.sessionId);
			setLines([]);
			setRpcStatus("connecting");
			attachRpc(res.sessionId);
			void openStream(res.sessionId);
			void refresh(true);
		} catch (e) {
			setErr(String(e));
			setPrompt(p);
		}
	};

	const abortRef = useRef<AbortController | null>(null);
	const openStream = async (id: string) => {
		abortRef.current?.abort();
		rpcRef.current?.close();
		setRpcStatus("idle");
		const ac = new AbortController();
		abortRef.current = ac;
		setStreamId(id);
		setLines([]);
		try {
			const res = await fetch(
				`/api/sessions/${encodeURIComponent(id)}/stream`,
				{ signal: ac.signal },
			);
			if (!res.body) return;
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const parts = buf.split("\n\n");
				buf = parts.pop() ?? "";
				for (const part of parts) {
					if (part.startsWith(":")) continue;
					const line = part.startsWith("data: ") ? part.slice(6) : part;
					if (line && !line.startsWith("event:"))
						setLines((s) => [...s, line].slice(-2000));
				}
			}
		} catch (e) {
			if ((e as Error).name !== "AbortError") setErr(String(e));
		}
	};

	const attachRpc = (id: string) => {
		rpcRef.current?.close();
		setRpcStatus("connecting");
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(
			`${proto}//${location.host}/api/sessions/${id}/ws`,
		);
		rpcRef.current = ws;
		ws.onopen = () => setRpcStatus("live");
		ws.onclose = () => setRpcStatus((s) => (s === "live" ? "closed" : s));
		ws.onerror = () => setRpcStatus("closed");
		ws.onmessage = (ev) => {
			try {
				const msg = JSON.parse(
					typeof ev.data === "string"
						? ev.data
						: new TextDecoder().decode(ev.data as ArrayBuffer),
				);
				if (msg.type === "rpc" && typeof msg.data === "string") {
					try {
						const inner = JSON.parse(msg.data);
						if (inner.type === "exit") setRpcStatus("closed");
						else if (inner.type) setLines((s) => [...s, msg.data].slice(-2000));
						else setLines((s) => [...s, msg.data].slice(-2000));
					} catch {
						setLines((s) => [...s, msg.data].slice(-2000));
					}
				}
			} catch {}
		};
		return ws;
	};

	const openSession = async (id: string, status?: string) => {
		abortRef.current?.abort();
		rpcRef.current?.close();
		setStreamId(id);
		setLines([]);
		if (status === "complete" || status === "error") {
			setRpcStatus("closed");
			void openStream(id);
			return;
		}
		setRpcStatus("connecting");
		try {
			const res = (await apiPost("/api/sessions", { resume: id })) as {
				sessionId: string;
				rpcLive?: boolean;
			};
			if (res.rpcLive) {
				attachRpc(res.sessionId);
			} else {
				setRpcStatus("closed");
			}
		} catch (e) {
			setErr(String(e));
			setRpcStatus("closed");
		}
		void openStream(id);
	};

	useEffect(
		() => () => {
			abortRef.current?.abort();
			rpcRef.current?.close();
		},
		[],
	);

	const sendFollowUp = async () => {
		if (!streamId || !followUp.trim()) return;
		try {
			await apiPost(`/api/sessions/${streamId}/prompt`, { text: followUp });
			setFollowUp("");
		} catch (e) {
			setErr(String(e));
		}
	};

	return (
		<div>
			<h2 style={{ marginTop: 0 }}>Sessions</h2>
			<p
				style={{
					color: "var(--muted)",
					fontSize: "var(--text-sm)",
					marginTop: -8,
				}}
			>
				Filesystem — <code>~/.omp/agent/sessions</code> · SSE + RPC WS for live.
			</p>
			<div className="card" style={{ marginBottom: 16 }}>
				<div
					style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}
				>
					<select
						aria-label="Project"
						value={projectId}
						onChange={(e) => setProjectId(e.target.value)}
						style={{ flex: 1, minWidth: 160 }}
					>
						<option value="">— project —</option>
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
					<ModelSelect
						value={model}
						onChange={setModel}
						allowNone
						style={{ flex: 1, minWidth: 160 }}
						ariaLabel="Model"
					/>
				</div>
				<div style={{ display: "flex", gap: 8 }}>
					<input
						aria-label="Prompt"
						placeholder="Prompt for new session"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void create();
						}}
						style={{ flex: 1 }}
					/>
					<button
						type="button"
						className="btn btn-primary"
						onClick={() => void create()}
						disabled={!prompt.trim()}
					>
						New chat
					</button>
				</div>
			</div>
			{err && (
				<div
					className="card"
					style={{
						borderColor: "var(--error)",
						color: "var(--error)",
						marginBottom: 12,
					}}
				>
					{err}
				</div>
			)}
			<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				<input
					aria-label="Search sessions"
					placeholder="Search title, cwd, id…"
					value={q}
					onChange={(e) => {
						setQ(e.target.value);
						setPage(0);
					}}
					style={{ flex: 1 }}
				/>
				<button type="button" className="btn" onClick={() => void refresh(true)}>
					Refresh
				</button>
			</div>
			{loading ? (
				<div style={{ display: "grid", gap: 8 }}>
					<div className="skeleton" style={{ height: 56 }} />
					<div className="skeleton" style={{ height: 56 }} />
				</div>
			) : filtered.length === 0 ? (
				<div
					className="card"
					style={{ textAlign: "center", color: "var(--muted)" }}
				>
					No sessions — start a new chat above or use the Terminal.
				</div>
			) : (
				<>
					<div style={{ display: "grid", gap: 8 }}>
						{paged.map((s) => (
							<div
								key={s.id}
								className="card session-card"
								style={{
									display: "flex",
									justifyContent: "space-between",
									gap: 12,
									alignItems: "center",
								}}
							>
								<button
									type="button"
									onClick={() => void openStream(s.id)}
									title={s.id}
									style={{
										textAlign: "start",
										flex: 1,
										background: "none",
										border: "none",
										cursor: "pointer",
										padding: 0,
									}}
								>
									<strong style={{ fontSize: "var(--text-sm)" }}>
										{s.title ?? `${s.id.slice(0, 8)}…${s.id.slice(-4)}`}
									</strong>
									<div
										style={{
											display: "flex",
											flexWrap: "wrap",
											gap: 4,
											alignItems: "center",
											marginTop: 4,
										}}
									>
										<span
											style={{
												color: "var(--muted)",
												fontSize: "var(--text-xs)",
											}}
										>
											{s.cwd.split("/").slice(-2).join("/")}
										</span>
										<span
											style={{
												color: "var(--muted)",
												fontSize: "var(--text-xs)",
											}}
										>
											· {s.messageCount} msgs
										</span>
										<span
											className={`badge ${s.status === "error" ? "badge-error" : s.status === "pending" ? "badge-warn" : ""}`}
										>
											{s.status ?? "—"}
										</span>
										<span
											style={{
												color: "var(--muted)",
												fontSize: "var(--text-xs)",
											}}
										>
											{s.modified.slice(0, 19).replace("T", " ")}
										</span>
									</div>
								</button>
								<div
									className="session-card-actions"
									style={{ display: "flex", gap: 6, flexShrink: 0 }}
								>
									<button
										type="button"
										className="btn btn-ghost"
										onClick={() => void openStream(s.id)}
										style={{ fontSize: "var(--text-xs)" }}
									>
										Preview
									</button>
									<button
										type="button"
										className="btn btn-primary"
										onClick={() =>
											onOpenChat
												? onOpenChat(s.id)
												: void openSession(s.id, s.status)
										}
									>
										Open
									</button>
								</div>
							</div>
						))}
					</div>
					{totalPages > 1 && (
						<div
							className="pagination"
							style={{
								display: "flex",
								gap: 8,
								justifyContent: "center",
								marginTop: 12,
								alignItems: "center",
							}}
						>
							<button
								type="button"
								className="btn"
								disabled={page === 0}
								onClick={() => setPage((p) => Math.max(0, p - 1))}
							>
								Prev
							</button>
							<span
								style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}
							>
								{page + 1} / {totalPages}
							</span>
							<button
								type="button"
								className="btn"
								disabled={page >= totalPages - 1}
								onClick={() => setPage((p) => p + 1)}
							>
								Next
							</button>
						</div>
					)}
				</>
			)}
			{streamId && (
				<div
					className="card stream-preview"
					style={{ marginTop: 16, padding: 0, overflow: "hidden" }}
				>
					<div
						style={{
							padding: "8px 12px",
							borderBottom: "1px solid var(--border)",
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
							gap: 8,
							flexWrap: "wrap",
						}}
					>
						<strong style={{ fontSize: "var(--text-sm)" }} title={streamId}>
							{streamId.slice(0, 8)}…{streamId.slice(-4)} ·{" "}
							{rpcStatus === "live"
								? "live"
								: rpcStatus === "connecting"
									? "connecting…"
									: rpcStatus === "closed"
										? "closed"
										: "preview"}{" "}
							<span
								className={`badge ${rpcStatus === "live" ? "badge-success" : rpcStatus === "connecting" ? "badge-running" : ""}`}
								style={{ marginInlineStart: 6 }}
							>
								{rpcStatus}
							</span>
						</strong>
						<span style={{ display: "flex", gap: 6 }}>
							{rpcStatus !== "live" && rpcStatus !== "connecting" && (
								<button
									type="button"
									className="btn"
									onClick={() => attachRpc(streamId)}
								>
									Attach RPC
								</button>
							)}
							<button
								type="button"
								className="btn"
								onClick={async () => {
									try {
										await apiPost(`/api/sessions/${streamId}/abort`, {});
									} catch {}
								}}
							>
								Abort
							</button>
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => {
									abortRef.current?.abort();
									rpcRef.current?.close();
									setRpcStatus("idle");
									setStreamId(null);
									setLines([]);
								}}
							>
								Close
							</button>
						</span>
					</div>
					<div
						ref={streamRef}
						style={{
							maxHeight: 420,
							overflow: "auto",
							background: "var(--panel)",
							padding: 12,
						}}
					>
						{lines.length === 0 ? (
							<span
								style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}
							>
								Waiting for stream…
							</span>
						) : (
							lines.map((l, i) => {
								const r = renderLine(l);
								if (!r) return null;
								return (
									<div
										key={i}
										style={{
											marginBottom: 8,
											padding: "6px 8px",
											borderRadius: 6,
											background:
												r.role === "user"
													? "var(--surface)"
													: r.role === "system"
														? "var(--panel)"
														: "var(--surface)",
											border: "1px solid var(--border)",
											fontSize: "var(--text-sm)",
											whiteSpace: "pre-wrap",
											wordBreak: "break-word",
										}}
									>
										<span
											className={`badge ${r.role === "user" ? "badge-running" : r.role === "system" ? "badge-warn" : ""}`}
											style={{ marginRight: 6 }}
										>
											{r.role}
										</span>
										{r.text.slice(0, 2000)}
									</div>
								);
							})
						)}
					</div>
					<div
						style={{
							padding: 8,
							borderTop: "1px solid var(--border)",
							display: "flex",
							gap: 8,
						}}
					>
						<input
							aria-label="Follow-up"
							placeholder="Follow-up prompt…"
							value={followUp}
							onChange={(e) => setFollowUp(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void sendFollowUp();
							}}
							style={{ flex: 1 }}
						/>
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => void sendFollowUp()}
							disabled={!followUp.trim()}
						>
							Send
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
