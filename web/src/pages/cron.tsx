import React, { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";

export function CronPage(): React.ReactElement {
	const [jobs, setJobs] = useState<{ id: string; name: string; cron_expr: string; prompt: string; model?: string | null; enabled: number }[]>([]);
	const [runs, setRuns] = useState<{ id: string; job_id: string; status: string; started_at: string; output?: string }[]>([]);
	const [name, setName] = useState("");
	const [cron, setCron] = useState("0 * * * *");
	const [prompt, setPrompt] = useState("");
	const [err, setErr] = useState("");

	const refresh = () => {
		apiGet("/api/cron/jobs").then(v => setJobs(v as typeof jobs)).catch(() => {});
		apiGet("/api/cron/runs").then(v => setRuns(v as typeof runs)).catch(() => {});
	};
	useEffect(() => { void refresh(); }, []);

	return (
		<div>
			<h2>Cron jobs (supercronic)</h2>
			{err && <p style={{ color: "red" }}>{err}</p>}
			<div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
				<input placeholder="name" value={name} onChange={e => setName(e.target.value)} />
				<input placeholder="cron (e.g. 0 * * * *)" value={cron} onChange={e => setCron(e.target.value)} />
				<textarea placeholder="prompt" value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} />
				<button
					type="button"
					onClick={async () => {
						setErr("");
						try { await apiPost("/api/cron/jobs", { name, cron, prompt }); setName(""); setPrompt(""); refresh(); } catch (e) { setErr(String(e)); }
					}}
				>
					Add job
				</button>
			</div>
			<ul>
				{jobs.map(j => (
					<li key={j.id} style={{ padding: 6, borderBottom: "1px solid #eee", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
						<span><strong>{j.name}</strong> · <code>{j.cron_expr}</code> · {j.enabled ? "enabled" : "disabled"}</span>
						<button type="button" onClick={async () => { await apiPatch(`/api/cron/jobs/${j.id}`, { enabled: j.enabled ? 0 : 1 }); refresh(); }}>{j.enabled ? "Disable" : "Enable"}</button>
						<button type="button" onClick={async () => { await apiPost(`/api/cron/jobs/${j.id}/trigger`, {}); setTimeout(refresh, 1500); }}>Run now</button>
						<button type="button" onClick={async () => { await apiDelete(`/api/cron/jobs/${j.id}`); refresh(); }}>Delete</button>
						<div style={{ width: "100%", fontSize: 12, color: "#666" }}>{j.prompt.slice(0, 120)}</div>
					</li>
				))}
			</ul>
			<h3>Recent runs</h3>
			<ul>
				{runs.slice(0, 20).map(r => (
					<li key={r.id} style={{ fontSize: 12, padding: 4 }}>
						{r.started_at.slice(0, 19)} · {r.job_id.slice(0, 8)} · {r.status} {r.output ? `· ${r.output.slice(0, 80)}` : ""}
					</li>
				))}
			</ul>
		</div>
	);
}
