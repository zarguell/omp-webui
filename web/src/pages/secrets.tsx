import React, { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../lib/api";

export function SecretsPage(): React.ReactElement {
	const [secrets, setSecrets] = useState<{ id: string; name: string; created_at: string }[]>([]);
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [err, setErr] = useState("");
	const refresh = () => apiGet("/api/secrets").then(v => setSecrets(v as typeof secrets)).catch(() => {});
	useEffect(() => { void refresh(); }, []);
	return (
		<div>
			<h2>Secrets</h2>
			<p style={{ fontSize: 13, color: "#666" }}>Stored AES-256-GCM, injected as $ENV into every omp spawn + terminal. Names must be valid env vars.</p>
			{err && <p style={{ color: "red" }}>{err}</p>}
			<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
				<input placeholder="NAME (e.g. ANTHROPIC_API_KEY)" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1 }} />
				<input placeholder="value" type="password" value={value} onChange={e => setValue(e.target.value)} style={{ flex: 1 }} />
				<button
					type="button"
					onClick={async () => {
						setErr("");
						try { await apiPost("/api/secrets", { name, value }); setName(""); setValue(""); refresh(); } catch (e) { setErr(String(e)); }
					}}
				>
					Add
				</button>
			</div>
			<ul>
				{secrets.map(s => (
					<li key={s.id} style={{ display: "flex", gap: 8 }}>
						<span>{s.name} — {s.created_at.slice(0, 19)}</span>
						<button type="button" onClick={async () => { await apiDelete(`/api/secrets/${s.id}`); refresh(); }}>Delete</button>
					</li>
				))}
			</ul>
		</div>
	);
}
