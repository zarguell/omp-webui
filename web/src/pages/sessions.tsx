import React, { useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";

export function SessionsPage(): React.ReactElement {
	const [sessions, setSessions] = useState<{ id: string; path: string; cwd: string; title?: string; modified: string; status?: string }[]>([]);
	const [prompt, setPrompt] = useState("");
	const [projectId, setProjectId] = useState("");
	const [model, setModel] = useState("");
	const [streamText, setStreamText] = useState("");

	useEffect(() => {
		apiGet("/api/sessions").then(v => setSessions(v as typeof sessions)).catch(() => {});
	}, []);

	const create = async () => {
		const res = (await apiPost("/api/sessions", { prompt, projectId: projectId || undefined, model: model || undefined })) as { sessionId: string };
		setPrompt("");
		const s = await apiGet("/api/sessions") as typeof sessions;
		setSessions(s);
		void res;
	};

	const openStream = async (id: string) => {
		setStreamText("");
		const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/stream`);
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
				const line = part.replace(/^data: /, "");
				if (line) setStreamText(s => s + line + "\n");
			}
		}
	};

	return (
		<div>
			<h2>Sessions</h2>
			<div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
				<input placeholder="projectId (optional)" value={projectId} onChange={e => setProjectId(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
				<input placeholder="model (optional)" value={model} onChange={e => setModel(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
			</div>
			<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				<input placeholder="prompt for new session" value={prompt} onChange={e => setPrompt(e.target.value)} style={{ flex: 1 }} />
				<button type="button" onClick={() => void create()} disabled={!prompt.trim()}>New</button>
			</div>
			<ul>
				{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
				{sessions.map(s => (
					<li key={s.path} onClick={() => void openStream(s.id)} style={{ cursor: "pointer", padding: 4, borderBottom: "1px solid #eee" }}>
						<strong>{s.title ?? s.id.slice(0, 8)}</strong> <small>{s.cwd} · {s.modified.slice(0, 19)} · {s.status ?? ""}</small>
					</li>
				))}
			</ul>
			{streamText && <pre style={{ background: "#f6f6f6", padding: 12, overflow: "auto", maxHeight: 400, whiteSpace: "pre-wrap" }}>{streamText}</pre>}
		</div>
	);
}
