import type React from "react";
import { useEffect, useState } from "react";
import { TerminalView } from "../components/terminal-view";
import { apiDelete, apiGet, apiPost } from "../lib/api";

export function TerminalPage(): React.ReactElement {
	const [terminals, setTerminals] = useState<
		{ id: string; cwd: string; createdAt: string }[]
	>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [cwd, setCwd] = useState("");
	const [command, setCommand] = useState("");
	const [loading, setLoading] = useState(true);

	const refresh = async (silent = false) => {
		if (!silent) setLoading(true);
		try {
			const next = (await apiGet("/api/terminals")) as typeof terminals;
			setTerminals(prev => {
				const nextIds = next.map(t => t.id).join(",");
				const prevIds = prev.map(t => t.id).join(",");
				return nextIds === prevIds ? prev : next;
			});
		} catch {
		} finally {
			setLoading(false);
		}
	};
	useEffect(() => {
		void refresh();
	}, []);
	useEffect(() => {
		const t = setInterval(() => void refresh(true), 3000);
		return () => clearInterval(t);
	}, []);

	const create = async () => {
		const res = (await apiPost("/api/terminals", {
			cwd: cwd || undefined,
			command: command || undefined,
			cols: 80,
			rows: 24,
		})) as { id: string };
		setCommand("");
		await refresh();
		setActiveId(res.id);
	};

	return (
		<div>
			<h2 style={{ marginTop: 0 }}>Terminal</h2>
			<p
				style={{
					color: "var(--muted)",
					fontSize: "var(--text-sm)",
					marginTop: -8,
				}}
			>
				PTY in container — run <code>omp --help</code>, <code>omp login</code>,{" "}
				<code>vim</code>, etc. Secrets injected as <code>$ENV</code>.
			</p>
			<div
				className="card"
				style={{ marginBottom: 12, display: "grid", gap: 8 }}
			>
				<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
					<label style={{ flex: "1 1 180px", display: "grid", gap: 4 }}>
						<span
							style={{
								fontSize: "var(--text-xs)",
								color: "var(--muted)",
								fontWeight: 600,
							}}
						>
							CWD
						</span>
						<input
							aria-label="Working directory"
							placeholder="(container cwd)"
							value={cwd}
							onChange={(e) => setCwd(e.target.value)}
						/>
					</label>
					<label style={{ flex: "1 1 180px", display: "grid", gap: 4 }}>
						<span
							style={{
								fontSize: "var(--text-xs)",
								color: "var(--muted)",
								fontWeight: 600,
							}}
						>
							Command
						</span>
						<input
							aria-label="Command"
							placeholder="omp --help  (default: shell)"
							value={command}
							onChange={(e) => setCommand(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void create();
							}}
						/>
					</label>
				</div>
				<div style={{ display: "flex", gap: 8 }}>
					<button
						type="button"
						className="btn btn-primary"
						onClick={() => void create()}
						style={{ flex: 1 }}
					>
						New
					</button>
					<button type="button" className="btn" onClick={() => void refresh()}>
						Refresh
					</button>
				</div>
			</div>
			{loading ? (
				<div className="skeleton" style={{ height: 36 }} />
			) : terminals.length === 0 ? (
				<p style={{ color: "var(--muted)" }}>
					No terminals — create one above.
				</p>
			) : (
				<div
					className="terminal-tabs"
					style={{
						display: "flex",
						gap: 8,
						marginBottom: 12,
						flexWrap: "wrap",
						alignItems: "center",
					}}
				>
					{terminals.map((t) => (
						<span key={t.id} style={{ display: "inline-flex", gap: 4 }}>
							<button
								type="button"
								className="btn"
								aria-pressed={activeId === t.id}
								style={
									activeId === t.id
										? {
												background: "var(--text-strong)",
												color: "var(--surface)",
												borderColor: "var(--text-strong)",
											}
										: undefined
								}
								onClick={() => setActiveId(t.id)}
							>
								{t.id.slice(0, 8)} {t.cwd.split("/").pop() ?? t.cwd}
							</button>
							<button
								type="button"
								className="btn btn-ghost"
								aria-label={`Close ${t.id.slice(0, 8)}`}
								onClick={async () => {
									if (!confirm(`Kill terminal ${t.id.slice(0, 8)}?`)) return;
									await apiDelete(`/api/terminals/${t.id}`);
									if (activeId === t.id) setActiveId(null);
									void refresh();
								}}
							>
								×
							</button>
						</span>
					))}
				</div>
			)}
			{activeId ? <TerminalView terminalId={activeId} /> : null}
		</div>
	);
}
