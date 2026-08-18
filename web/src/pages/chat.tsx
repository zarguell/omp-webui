import React, { useCallback, useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { apiGet, apiPost } from "../lib/api";

type ChatMessage = {
	role: "user" | "assistant" | "system";
	text: string;
	id: number;
	detail?: string;
};

function shortPath(p: string): string {
	if (!p) return "";
	const parts = p.replace(/\\/g, "/").split("/");
	return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

function summarizeToolCall(name: string, args: Record<string, unknown>, startData?: { intent?: string; args?: Record<string, unknown> }): string {
	const a = args ?? {};
	const intent = startData?.intent ?? (a as { i?: string }).i ?? "";

	switch (name) {
		case "read": return `→ read ${shortPath(String(a.path ?? ""))}${intent ? ` — ${intent}` : ""}`;
		case "edit": {
			const fp = shortPath(String(a.path ?? ""));
			if (intent) return `→ edit ${fp} — ${intent}`;
			const old = String(a.old_string ?? "").split("\n")[0]?.trim().slice(0, 60) ?? "";
			return `→ edit ${fp}${old ? ` — "${old}…"` : ""}`;
		}
		case "bash": {
			const cmd = String(a.command ?? "").slice(0, 100);
			return `$ ${cmd}${intent ? ` — ${intent}` : ""}`;
		}
		case "write": return `→ write ${shortPath(String(a.path ?? ""))}`;
		case "grep": return `→ grep ${String(a.pattern ?? "").slice(0, 60)}${a.path ? ` in ${shortPath(String(a.path))}` : ""}`;
		case "glob": return `→ glob ${String(a.path ?? a.i ?? "").slice(0, 60)}`;
		case "lsp": return `→ lsp ${a.action ?? ""}${a.file ? ` ${shortPath(String(a.file))}` : ""}${a.symbol ? ` #${a.symbol}` : ""}`;
		case "ast_edit": return `→ ast_edit ${shortPath(String((a.paths as string[])?.[0] ?? ""))}`;
		case "task": return `→ task${a.i ? ` — ${String(a.i).slice(0, 80)}` : ""}`;
		case "todo": return `→ todo ${a.op}${a.task ? ` — ${String(a.task).slice(0, 60)}` : ""}`;
		case "debug": return `→ debug ${a.action}${a.program ? ` ${shortPath(String(a.program))}` : ""}`;
		case "browser": return `→ browser ${a.action}${a.url ? ` ${String(a.url).slice(0, 60)}` : ""}`;
		default: return `→ ${name}${intent ? ` — ${intent}` : ""}`;
	}
}

function formatToolDetail(name: string, args: Record<string, unknown>): string {
	const a = args ?? {};
	switch (name) {
		case "read": return `path: ${a.path ?? ""}${a.offset ? `\noffset: ${a.offset}` : ""}${a.limit ? `, limit: ${a.limit}` : ""}`;
		case "edit": {
			const lines: string[] = [`path: ${a.path ?? ""}`];
			if (a.old_string) lines.push(`old:\n${String(a.old_string).slice(0, 500)}${String(a.old_string).length > 500 ? "\n…" : ""}`);
			if (a.new_string) lines.push(`new:\n${String(a.new_string).slice(0, 500)}${String(a.new_string).length > 500 ? "\n…" : ""}`);
			return lines.join("\n\n");
		}
		case "bash": return `command:\n${a.command ?? ""}`;
		case "write": return `path: ${a.path ?? ""}\n\n${String(a.content ?? "").slice(0, 800)}${String(a.content ?? "").length > 800 ? "\n…" : ""}`;
		case "grep": return `pattern: ${a.pattern ?? ""}${a.path ? `\npath: ${a.path}` : ""}`;
		case "glob": return `path: ${a.path ?? a.i ?? ""}`;
		case "lsp": return `action: ${a.action ?? ""}${a.file ? `\nfile: ${a.file}` : ""}${a.symbol ? `\nsymbol: ${a.symbol}` : ""}${a.line ? `\nline: ${a.line}` : ""}`;
		case "ast_edit": return JSON.stringify(a, null, 2).slice(0, 1000);
		case "task": return JSON.stringify(a, null, 2).slice(0, 1000);
		default: return JSON.stringify(a, null, 2).slice(0, 1000);
	}
}

function parseMessages(lines: string[]): ChatMessage[] {
	// First pass: collect tool_execution_start data by toolCallId
	const toolStarts = new Map<string, { intent?: string; args?: Record<string, unknown> }>();
	for (const line of lines) {
		try {
			const obj = JSON.parse(line);
			const entry = obj.entry ?? obj;
			if (entry.customType === "tool_execution_start" && entry.data) {
				const d = entry.data as { toolCallId?: string; intent?: string; args?: Record<string, unknown> };
				if (d.toolCallId) toolStarts.set(d.toolCallId, { intent: d.intent, args: d.args });
			}
		} catch {}
	}

	const msgs: ChatMessage[] = [];
	let id = 0;
	for (const line of lines) {
		try {
			const obj = JSON.parse(line);
			const entry = obj.entry ?? obj;
			const msg = entry.message ?? entry;

			if (msg?.role === "assistant" && Array.isArray(msg.content)) {
				const textParts: string[] = [];
				for (const part of msg.content) {
					if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
						textParts.push(part.text);
					}
				}
				if (textParts.length > 0) {
					msgs.push({ role: "assistant", text: textParts.join("\n\n"), id: id++ });
					continue;
				}
				for (const part of msg.content) {
					if (part.type === "toolCall" && part.name) {
						const startData = part.id ? toolStarts.get(part.id) : undefined;
						const args = part.arguments ?? {};
						msgs.push({
							role: "system",
							text: summarizeToolCall(part.name, args, startData),
							detail: formatToolDetail(part.name, args),
							id: id++,
						});
					}
				}
				continue;
			}

			if (msg?.role === "toolResult" && Array.isArray(msg.content)) {
				const text = msg.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
				if (text) {
					const preview = text.split("\n").slice(0, 8).join("\n");
					msgs.push({ role: "system", text: preview + (text.split("\n").length > 8 ? "\n…" : ""), id: id++ });
				}
				continue;
			}

			if (msg?.role === "user" && typeof msg.content === "string") {
				msgs.push({ role: "user", text: msg.content, id: id++ });
				continue;
			}

			if (Array.isArray(msg?.content)) {
				const text = msg.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
				if (text) {
					msgs.push({ role: msg.role === "user" ? "user" : "assistant", text, id: id++ });
					continue;
				}
			}

			if (typeof msg?.content === "string" && msg.content.trim()) {
				msgs.push({ role: msg.role === "user" ? "user" : "assistant", text: msg.content, id: id++ });
			}
		} catch {
			// skip malformed lines
		}
	}
	return msgs;
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {}
	}, [text]);
	return (
		<button
			type="button"
			onClick={handleCopy}
			title="Copy to clipboard"
			style={{
				background: "none",
				border: "none",
				cursor: "pointer",
				padding: 2,
				opacity: 0.4,
				transition: "opacity 0.15s",
				color: "var(--muted)",
				flexShrink: 0,
			}}
			onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
			onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.4"; }}
		>
			{copied ? (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
			) : (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
			)}
		</button>
	);
}

function MarkdownMessage({ text }: { text: string }): React.ReactElement {
	const html = marked.parse(text, { async: false }) as string;
	return (
		<div
			className="markdown-body"
			dangerouslySetInnerHTML={{ __html: html }}
			style={{ fontSize: "var(--text-sm)", lineHeight: 1.6 }}
		/>
	);
}

function UserMessage({ text }: { text: string }): React.ReactElement {
	return (
		<div style={{
			fontSize: "var(--text-sm)",
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
			lineHeight: 1.6,
		}}>
			{text}
		</div>
	);
}

function SystemMessage({ text, detail }: { text: string; detail?: string }): React.ReactElement {
	const [expanded, setExpanded] = useState(false);
	const isToolCall = text.startsWith("→") || text.startsWith("$");
	if (isToolCall) {
		const isCmd = text.startsWith("$");
		return (
			<div style={{ fontSize: "var(--text-xs)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
				<div
					style={{
						display: "flex",
						alignItems: "flex-start",
						gap: 6,
						cursor: detail ? "pointer" : "default",
						userSelect: "none",
					}}
					onClick={() => detail && setExpanded(v => !v)}
				>
					<span style={{
						flexShrink: 0,
						width: 6,
						height: 6,
						borderRadius: "50%",
						background: isCmd ? "var(--primary)" : "var(--success)",
						marginTop: 5,
					}} />
					<span style={{ color: isCmd ? "var(--primary)" : "var(--text)", fontWeight: 500, flex: 1 }}>
						{text.split("\n")[0]}
					</span>
					{detail && (
						<span style={{ color: "var(--muted)", flexShrink: 0, transition: "transform 0.15s", transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>
							▶
						</span>
					)}
				</div>
				{expanded && detail && (
					<pre style={{
						margin: "6px 0 0 12px",
						padding: "6px 8px",
						background: "var(--panel)",
						border: "1px solid var(--border)",
						borderRadius: 4,
						fontSize: "var(--text-xs)",
						fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
						color: "var(--text)",
						whiteSpace: "pre-wrap",
						wordBreak: "break-all",
						overflow: "auto",
						maxHeight: 300,
						lineHeight: 1.5,
					}}>
						{detail}
					</pre>
				)}
			</div>
		);
	}
	return (
		<code style={{
			fontSize: "var(--text-xs)",
			color: "var(--muted)",
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			opacity: 0.7,
		}}>
			{text.length > 200 ? text.slice(0, 200) + "…" : text}
		</code>
	);
}

function MessageBubble({ msg }: { msg: ChatMessage }): React.ReactElement {
	const isSystemTool = msg.role === "system" && (msg.text.startsWith("→") || msg.text.startsWith("$"));
	const isSystemResult = msg.role === "system" && !isSystemTool;

	// System tool results: minimal, compact, no card
	if (isSystemResult) {
		return (
			<div style={{ marginBottom: 4, padding: "2px 0" }}>
				<SystemMessage text={msg.text} detail={msg.detail} />
			</div>
		);
	}

	const roleColors: Record<string, { bg: string; border: string; badge: string; badgeBg: string; badgeBorder: string }> = {
		user: { bg: "var(--surface)", border: "var(--border)", badge: "var(--primary)", badgeBg: "oklch(0.95 0.05 285)", badgeBorder: "oklch(0.86 0.08 285)" },
		assistant: { bg: "var(--panel)", border: "var(--border)", badge: "var(--success)", badgeBg: "oklch(0.96 0.04 145)", badgeBorder: "oklch(0.88 0.06 145)" },
		system: { bg: "var(--panel)", border: "1px dashed var(--border)", badge: "var(--muted)", badgeBg: "var(--panel)", badgeBorder: "var(--border)" },
	};
	const c = roleColors[msg.role] ?? roleColors.system;

	return (
		<div style={{
			background: c.bg,
			border: c.border,
			borderRadius: 8,
			padding: isSystemTool ? "8px 14px" : "10px 14px",
			marginBottom: isSystemTool ? 6 : 10,
			position: "relative",
		}}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: isSystemTool ? 2 : 6 }}>
				<span
					className="badge"
					style={{
						background: c.badgeBg,
						color: c.badge,
						borderColor: c.badgeBorder,
						fontSize: "var(--text-xs)",
					}}
				>
					{msg.role}
				</span>
				<CopyButton text={msg.text} />
			</div>
			{msg.role === "assistant" ? (
				<MarkdownMessage text={msg.text} />
			) : msg.role === "user" ? (
				<UserMessage text={msg.text} />
			) : (
				<SystemMessage text={msg.text} detail={msg.detail} />
			)}
		</div>
	);
}

export function ChatPage({ sessionId, onBack }: { sessionId: string; onBack: () => void }): React.ReactElement {
	const [lines, setLines] = useState<string[]>([]);
	const [status, setStatus] = useState<"loading" | "streaming" | "done">("loading");
	const [title, setTitle] = useState("");
	const [model, setModel] = useState("");
	const [availableModels, setAvailableModels] = useState<{ selector: string; name: string; provider: string }[]>([]);
	const [followUp, setFollowUp] = useState("");
	const abortRef = useRef<AbortController | null>(null);
	const rpcRef = useRef<WebSocket | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	// Auto-scroll
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [lines]);

	// Spawn RPC session for interactive prompts
	useEffect(() => {
		let active = true;
		void apiPost("/api/sessions", { resume: sessionId }).then((res: unknown) => {
			if (!active) return;
			const d = res as { sessionId?: string; rpcLive?: boolean };
			if (d.rpcLive && d.sessionId) {
				const proto = location.protocol === "https:" ? "wss:" : "ws:";
				const ws = new WebSocket(`${proto}//${location.host}/api/sessions/${d.sessionId}/ws`);
				rpcRef.current = ws;
				ws.onopen = () => {};
				ws.onclose = () => {};
				ws.onerror = () => {};
				ws.onmessage = () => {};
			}
		}).catch(() => {});
		return () => { active = false; };
	}, [sessionId]);

	// Fetch available models and session model
	useEffect(() => {
		void apiGet("/api/models").then((data: unknown) => {
			const d = data as { models?: { selector: string; name: string; provider: string }[] };
			if (d.models) setAvailableModels(d.models.map(m => ({ selector: m.selector, name: m.name, provider: m.provider })));
		}).catch(() => {});
		void apiGet(`/api/sessions/${sessionId}/model`).then((data: unknown) => {
			const d = data as { model?: string };
			if (d.model) setModel(d.model);
		}).catch(() => {});
	}, [sessionId]);

	// Stream SSE with auto-reconnect
	useEffect(() => {
		let active = true;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

		const connect = () => {
			if (!active) return;
			const ac = new AbortController();
			abortRef.current = ac;

			fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stream`, { signal: ac.signal })
				.then(res => {
					if (!res.body || !active) return;
					setStatus("streaming");
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					let buf = "";
					const pump = (): Promise<void> => reader.read().then(({ value, done }) => {
						if (done || !active) { setStatus("done"); return; }
						buf += decoder.decode(value, { stream: true });
						const parts = buf.split("\n\n");
						buf = parts.pop() ?? "";
						for (const part of parts) {
							if (part.startsWith(":")) continue;
							const dataLine = part.startsWith("data: ") ? part.slice(6) : part;
							if (!dataLine || dataLine.startsWith("event:")) continue;
							try {
								const obj = JSON.parse(dataLine);
								if (obj.type === "title" && obj.title) setTitle(obj.title);
								if (obj.type === "model_change" && obj.model) setModel(obj.model);
							} catch {}
							if (active) setLines(s => [...s, dataLine]);
						}
						return pump();
					});
					return pump();
				})
				.catch(e => {
					if ((e as Error).name === "AbortError" || !active) return;
					// Reconnect after 2s on error
					if (active) reconnectTimer = setTimeout(connect, 2000);
				});
		};
		connect();

		return () => {
			active = false;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			abortRef.current?.abort();
		};
	}, [sessionId]);

	// Cleanup on unmount
	useEffect(() => () => {
		abortRef.current?.abort();
		rpcRef.current?.close();
	}, []);

	const sendFollowUp = useCallback(async () => {
		if (!followUp.trim()) return;
		const text = followUp;
		setFollowUp("");
		try {
			await apiPost(`/api/sessions/${sessionId}/prompt`, { text });
		} catch {}
	}, [followUp, sessionId]);

	const changeModel = useCallback(async (selector: string) => {
		try {
			await apiPost(`/api/sessions/${sessionId}/model`, { selector });
			setModel(selector);
		} catch {}
	}, [sessionId]);

	const messages = parseMessages(lines);

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100dvh", overflow: "hidden" }}>
			{/* Header */}
			<div className="chat-header" style={{
				padding: "10px 16px",
				borderBottom: "1px solid var(--border)",
				background: "var(--surface)",
				display: "flex",
				alignItems: "center",
				gap: 10,
				flexShrink: 0,
			}}>
				<button
					type="button"
					onClick={onBack}
					className="btn btn-ghost"
					style={{ fontSize: "var(--text-sm)", padding: "4px 8px", flexShrink: 0 }}
				>
					← Sessions
				</button>
				<div style={{ flex: 1, minWidth: 0 }}>
					<strong style={{ fontSize: "var(--text-sm)" }}>{title || sessionId.slice(0, 12) + "…"}</strong>
					<span style={{ color: "var(--muted)", fontSize: "var(--text-xs)", marginInlineStart: 8 }}>
						{messages.length} messages
						{status === "streaming" && " · streaming…"}
					</span>
				</div>
				{model && (
					<select
						aria-label="Model"
						value={model}
						onChange={e => void changeModel(e.target.value)}
						style={{ fontSize: "var(--text-xs)", padding: "4px 8px", maxWidth: "100%", flex: "1 1 0", minWidth: 0 }}
						title={model}
					>
						<option value={model}>{availableModels.find(m => m.selector === model)?.provider}/{availableModels.find(m => m.selector === model)?.name ?? model.split("/").pop()}</option>
						{availableModels.filter(m => m.selector !== model).map(m => (
							<option key={m.selector} value={m.selector}>{m.provider}/{m.name}</option>
						))}
					</select>
				)}
			</div>

			{/* Messages */}
			<div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: 16 }}>
				{messages.length === 0 && status === "loading" && (
					<div style={{ color: "var(--muted)", fontSize: "var(--text-sm)", textAlign: "center", marginTop: 40 }}>Loading session…</div>
				)}
				{messages.length === 0 && status === "done" && (
					<div style={{ color: "var(--muted)", fontSize: "var(--text-sm)", textAlign: "center", marginTop: 40 }}>No messages in this session.</div>
				)}
				{messages.map(msg => (
					<MessageBubble key={msg.id} msg={msg} />
				))}
			</div>

			{/* Follow-up input */}
			<div style={{
				padding: "8px 16px",
				borderTop: "1px solid var(--border)",
				background: "var(--surface)",
				display: "flex",
				gap: 8,
				flexShrink: 0,
			}}>
				<input
					aria-label="Follow-up prompt"
					placeholder="Send a follow-up…"
					value={followUp}
					onChange={e => setFollowUp(e.target.value)}
					onKeyDown={e => { if (e.key === "Enter") void sendFollowUp(); }}
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
	);
}
