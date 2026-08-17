import React, { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../lib/api";

export function ProjectsPage(): React.ReactElement {
	const [projects, setProjects] = useState<{ id: string; name: string; cwd: string; default_model?: string | null }[]>([]);
	const [name, setName] = useState("");
	const [cwd, setCwd] = useState("");
	const [err, setErr] = useState("");

	const refresh = () => apiGet("/api/projects").then(v => setProjects(v as typeof projects)).catch(() => {});
	useEffect(() => { void refresh(); }, []);

	return (
		<div>
			<h2>Projects</h2>
			{err && <p style={{ color: "red" }}>{err}</p>}
			<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				<input placeholder="name" value={name} onChange={e => setName(e.target.value)} />
				<input placeholder="/absolute/cwd" value={cwd} onChange={e => setCwd(e.target.value)} style={{ flex: 1 }} />
				<button
					type="button"
					onClick={async () => {
						setErr("");
						try { await apiPost("/api/projects", { name, cwd }); setName(""); setCwd(""); refresh(); } catch (e) { setErr(String(e)); }
					}}
				>
					Add
				</button>
			</div>
			<ul>
				{projects.map(p => (
					<li key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: 4 }}>
						<span><strong>{p.name}</strong> — {p.cwd} {p.default_model ? `· ${p.default_model}` : ""}</span>
						<button type="button" onClick={async () => { await apiDelete(`/api/projects/${p.id}`); refresh(); }}>Delete</button>
					</li>
				))}
			</ul>
		</div>
	);
}
