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
		if (obj.type === "message" && obj.role && obj.content) {
			return {
				role: obj.role as "user" | "assistant" | "system",
				text: typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content),
			};
		}
		if (obj.type === "text" && typeof obj.text === "string") {
			return { role: "assistant", text: obj.text };
		}
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
	const [historyOpen, setHistoryOpen] = useState(false);

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

	const newChat = () => {
		abortRef.current?.abort();
		rpcRef.current?.close();
		setStreamId(null);
		setLines([]);
		setRpcStatus("idle");
		setFollowUp("");
	};

	const parsedMessages = useMemo(() => {
		return lines
			.map(renderLine)
			.filter((m): m is NonNullable<typeof m> => m !== null);
	}, [lines]);

	const isActive = streamId !== null;

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				height: "calc(100dvh - 32px)",
				maxWidth: "none",
			}}
		>
			{/* Active chat view */}
			{isActive && (
				<div
					style={{
						flex: 1,
						display: "flex",
						flexDirection: "column",
						minHeight: 0,
					}}
				>
					{/* Chat header */}
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 8,
							marginBottom: 8,
							flexShrink: 0,
						}}
					>
						<button
							type="button"
							className="btn btn-ghost"
							onClick={newChat}
							style={{ fontSize: "var(--text-xs)" }}
						>
							← New chat
						</button>
						<span
							className={`badge ${rpcStatus === "live" ? "badge-success" : rpcStatus === "connecting" ? "badge-running" : "badge-warn"}`}
						>
							{rpcStatus}
						</span>
					</div>

					{/* Messages */}
					<div
						ref={streamRef}
						style={{
							flex: 1,
							overflow: "auto",
							display: "grid",
							gap: 12,
							alignContent: "start",
							paddingBottom: 16,
						}}
					>
						{parsedMessages.map((msg, i) => (
							<div
								key={i}
								className="card"
								style={{
									padding: "10px 14px",
									borderColor:
										msg.role === "user"
											? "var(--primary)"
											: msg.role === "system"
												? "var(--warning)"
												: undefined,
								}}
							>
								<div
									style={{
										fontSize: "var(--text-xs)",
										color: "var(--muted)",
										marginBottom: 4,
										fontWeight: 600,
									}}
								>
									{msg.role}
								</div>
								<div style={{ fontSize: "var(--text-sm)", whiteSpace: "pre-wrap" }}>
									{msg.text}
								</div>
							</div>
						))}
						{lines.length === 0 && rpcStatus !== "closed" && (
							<div style={{ color: "var(--muted)", fontSize: "var(--text-sm)", textAlign: "center", padding: 24 }}>
								Waiting for response…
							</div>
						)}
					</div>

					{/* Follow-up input */}
					<div style={{ display: "flex", gap: 8, marginTop: 8, flexShrink: 0 }}>
						<input
							aria-label="Follow-up"
							placeholder={rpcStatus === "closed" ? "Session ended — open from history to resume" : "Type a follow-up…"}
							value={followUp}
							onChange={(e) => setFollowUp(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									void sendFollowUp();
								}
							}}
							disabled={rpcStatus === "closed"}
							style={{ flex: 1 }}
						/>
						<button
							type="button"
							className="btn btn-primary"
							onClick={() => void sendFollowUp()}
							disabled={rpcStatus === "closed" || !followUp.trim()}
						>
							Send
						</button>
					</div>
				</div>
			)}

			{/* Landing / prompt view */}
			{!isActive && (
				<div
					style={{
						flex: 1,
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						gap: 24,
						padding: "0 16px",
					}}
				>
					<div style={{ textAlign: "center" }}>
						<h2 style={{ marginTop: 0, fontSize: "var(--text-xl)" }}>omp</h2>
						<p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginTop: -4 }}>
							What are you working on?
						</p>
					</div>

					{err && (
						<div
							className="card"
							style={{
								borderColor: "var(--error)",
								color: "var(--error)",
								width: "100%",
								maxWidth: 640,
							}}
						>
							{err}
						</div>
					)}

					<div
						style={{
							width: "100%",
							maxWidth: 640,
							display: "flex",
							flexDirection: "column",
							gap: 8,
						}}
					>
						<textarea
							aria-label="Prompt"
							placeholder="Describe what you want to build, fix, or explore…"
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									void create();
								}
							}}
							rows={4}
							style={{
								resize: "none",
								fontSize: "var(--text-base)",
								lineHeight: 1.5,
								padding: 12,
							}}
						/>
						<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
							<select
								aria-label="Project"
								value={projectId}
								onChange={(e) => setProjectId(e.target.value)}
								style={{ flex: 1, minWidth: 0, fontSize: "var(--text-xs)" }}
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
								style={{ flex: 1, minWidth: 0, fontSize: "var(--text-xs)" }}
								ariaLabel="Model"
							/>
							<button
								type="button"
								className="btn btn-primary"
								onClick={() => void create()}
								disabled={!prompt.trim()}
								style={{ flexShrink: 0 }}
							>
								Start →
							</button>
						</div>
						<p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", textAlign: "center", margin: 0 }}>
							Ctrl+Enter to send · Secrets injected as $ENV
						</p>
					</div>
				</div>
			)}

			{/* Session history — collapsible */}
			<div style={{ borderTop: "1px solid var(--border)", marginTop: isActive ? 0 : 16 }}>
				<button
					type="button"
					onClick={() => setHistoryOpen((v) => !v)}
					style={{
						width: "100%",
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						padding: "10px 0",
						background: "none",
						border: "none",
						cursor: "pointer",
						color: "var(--muted)",
						fontSize: "var(--text-sm)",
					}}
				>
					<span>
						{historyOpen ? "▾" : "▸"} History · {sessions.length} sessions
					</span>
					<div style={{ display: "flex", gap: 6 }}>
						<input
							aria-label="Search sessions"
							placeholder="Search…"
							value={q}
							onChange={(e) => {
								setQ(e.target.value);
								setPage(0);
							}}
							onClick={(e) => e.stopPropagation()}
							style={{ fontSize: "var(--text-xs)", padding: "4px 8px", width: 160 }}
						/>
						<button
							type="button"
							className="btn btn-ghost"
							onClick={(e) => {
								e.stopPropagation();
								void refresh(true);
							}}
							style={{ fontSize: "var(--text-xs)", padding: "4px 8px" }}
						>
							↻
						</button>
					</div>
				</button>

				{historyOpen && (
					<div style={{ maxHeight: 300, overflow: "auto", display: "grid", gap: 4, paddingBottom: 8 }}>
						{loading ? (
							<div className="skeleton" style={{ height: 36 }} />
						) : paged.length === 0 ? (
							<p style={{ color: "var(--muted)", fontSize: "var(--text-xs)", textAlign: "center" }}>
								No sessions yet.
							</p>
						) : (
							paged.map((s) => (
								<div
									key={s.id}
									className="card"
									style={{
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										padding: "8px 12px",
										gap: 8,
									}}
								>
									<button
										type="button"
										onClick={() =>
											onOpenChat
												? onOpenChat(s.id)
												: void openSession(s.id, s.status)
										}
										style={{
											textAlign: "start",
											flex: 1,
											background: "none",
											border: "none",
											cursor: "pointer",
											padding: 0,
											minWidth: 0,
										}}
									>
										<div
											style={{
												fontSize: "var(--text-sm)",
												fontWeight: 500,
												whiteSpace: "nowrap",
												overflow: "hidden",
												textOverflow: "ellipsis",
											}}
										>
											{s.title ?? `${s.id.slice(0, 8)}…`}
										</div>
										<div
											style={{
												display: "flex",
												gap: 6,
												alignItems: "center",
												marginTop: 2,
											}}
										>
											<span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>
												{s.messageCount} msgs
											</span>
											<span className={`badge ${s.status === "error" ? "badge-error" : s.status === "pending" ? "badge-warn" : ""}`} style={{ fontSize: "10px" }}>
												{s.status ?? "—"}
											</span>
											<span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>
												{s.modified.slice(0, 16).replace("T", " ")}
											</span>
										</div>
									</button>
									<button
										type="button"
										className="btn btn-ghost"
										onClick={() => void openStream(s.id)}
										style={{ fontSize: "var(--text-xs)", padding: "4px 8px" }}
									>
										Preview
									</button>
								</div>
							))
						)}
						{totalPages > 1 && (
							<div
								style={{
									display: "flex",
									gap: 8,
									justifyContent: "center",
									marginTop: 4,
									alignItems: "center",
								}}
							>
								<button
									type="button"
									className="btn btn-ghost"
									onClick={() => setPage((p) => Math.max(0, p - 1))}
									disabled={page === 0}
									style={{ fontSize: "var(--text-xs)" }}
								>
									←
								</button>
								<span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
									{page + 1} / {totalPages}
								</span>
								<button
									type="button"
									className="btn btn-ghost"
									onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
									disabled={page >= totalPages - 1}
									style={{ fontSize: "var(--text-xs)" }}
								>
									→
								</button>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
