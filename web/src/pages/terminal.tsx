import React, { useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import { TerminalView } from "../components/terminal-view";

export function TerminalPage(): React.ReactElement {
	const [terminals, setTerminals] = useState<{ id: string; cwd: string; createdAt: string }[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [cwd, setCwd] = useState("");
	const [command, setCommand] = useState("");

	const refresh = () => apiGet("/api/terminals").then(v => setTerminals(v as typeof terminals)).catch(() => {});
	useEffect(() => { void refresh(); }, []);

	const create = async () => {
		const res = (await apiPost("/api/terminals", { cwd: cwd || undefined, command: command || undefined, cols: 80, rows: 24 })) as { id: string };
		setCommand("");
		await refresh();
		setActiveId(res.id);
	};

	return (
		<div>
			<h2>Terminal</h2>
			<div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
				<input placeholder="cwd (optional)" value={cwd} onChange={e => setCwd(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
				<input placeholder="command (optional, default shell)" value={command} onChange={e => setCommand(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
				<button type="button" onClick={() => void create()}>New</button>
				<button type="button" onClick={() => void refresh()}>Refresh</button>
			</div>
			<div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
				{terminals.map(t => (
					<button
						key={t.id}
						type="button"
						onClick={() => setActiveId(t.id)}
						style={{ padding: "4px 8px", background: activeId === t.id ? "#111" : "#eee", color: activeId === t.id ? "#fff" : "#111" }}
					>
						{t.id.slice(0, 8)} {t.cwd.split("/").pop()}
					</button>
				))}
			</div>
			{activeId ? <TerminalView terminalId={activeId} /> : <p style={{ color: "#666" }}>Create or select a terminal. Run <code>omp --help</code>, <code>omp login</code>, <code>omp models</code>, etc.</p>}
		</div>
	);
}
