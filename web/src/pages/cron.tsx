import React, { useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";

export function CronPage(): React.ReactElement {
	const [jobs, setJobs] = useState<{ id: string; name: string; cron_expr: string; prompt: string; model?: string | null; enabled: number; project_id?: string | null; cwd?: string | null }[]>([]);
	const [runs, setRuns] = useState<{ id: string; job_id: string; status: string; started_at: string; output?: string | null }[]>([]);
	const [loading, setLoading] = useState(true);
	const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
	const [name, setName] = useState("");
	const [cron, setCron] = useState("0 * * * *");
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState("");
	const [projectId, setProjectId] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [editCron, setEditCron] = useState("");
	const [editPrompt, setEditPrompt] = useState("");
	const [err, setErr] = useState("");

	const refresh = async () => {
		setLoading(true);
		try {
			const [j, r, p] = await Promise.all([apiGet("/api/cron/jobs"), apiGet("/api/cron/runs"), apiGet("/api/projects").catch(() => [])]);
			setJobs(j as typeof jobs); setRuns(r as typeof runs); setProjects((p as typeof projects) ?? []);
		} catch (e) { setErr(String(e)); } finally { setLoading(false); }
	};
	useEffect(() => { void refresh(); }, []);

	const preview = useMemo(() => {
		try {
			const cronstrue = require("cronstrue") as { toString(s: string): string };
			return cronstrue.toString(cron);
		} catch { return ""; }
	}, [cron]);

	const editPreview = useMemo(() => {
		try {
			const cronstrue = require("cronstrue") as { toString(s: string): string };
			return editCron ? cronstrue.toString(editCron) : "";
		} catch { return ""; }
	}, [editCron]);

	return (
		<div>
			<h2 style={{ marginTop: 0 }}>Cron</h2>
			<p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginTop: -8 }}>Supercronic — crontab at <code>/data/crontab</code>.</p>
			<div className="card" style={{ marginBottom: 16, display: "grid", gap: 8 }}>
				<label style={{ display: "grid", gap: 4 }}><span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", fontWeight: 600 }}>Name</span><input aria-label="Job name" placeholder="hourly check" value={name} onChange={e => setName(e.target.value)} /></label>
				<label style={{ display: "grid", gap: 4 }}><span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", fontWeight: 600 }}>Cron</span><input aria-label="Cron expression" placeholder="0 * * * *" value={cron} onChange={e => setCron(e.target.value)} /></label>
				{preview && <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>{preview}</span>}
				<label style={{ display: "grid", gap: 4 }}><span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", fontWeight: 600 }}>Project</span>
					<select aria-label="Project" value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">— none —</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
				</label>
				<label style={{ display: "grid", gap: 4 }}><span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", fontWeight: 600 }}>Model (optional)</span><input aria-label="Model" placeholder="anthropic/claude-sonnet-4-20250514" value={model} onChange={e => setModel(e.target.value)} /></label>
				<label style={{ display: "grid", gap: 4 }}><span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", fontWeight: 600 }}>Prompt</span><textarea aria-label="Prompt" placeholder="prompt for omp --mode json -p" value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} /></label>
				{err && <span style={{ color: "var(--error)", fontSize: "var(--text-sm)" }}>{err}</span>}
				<button
					type="button"
					className="btn btn-primary"
					disabled={!name.trim() || !cron.trim() || !prompt.trim()}
					onClick={async () => {
						setErr("");
						try { await apiPost("/api/cron/jobs", { name, cron, prompt, model: model || undefined, projectId: projectId || undefined }); setName(""); setPrompt(""); void refresh(); } catch (e) { setErr(String(e)); }
					}}
				>
					Add job
				</button>
			</div>
			{loading ? <div className="skeleton" style={{ height: 48 }} /> : jobs.length === 0 ? (
				<div className="card" style={{ textAlign: "center", color: "var(--muted)" }}>No jobs — add one above.</div>
			) : (
				<div style={{ display: "grid", gap: 8 }}>
					{jobs.map(j => (
						<div key={j.id} className="card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "10px 12px" }}>
							{editing === j.id ? (
								<div style={{ flex: 1, display: "grid", gap: 6 }}>
									<input aria-label="Edit cron" value={editCron} onChange={e => setEditCron(e.target.value)} />
									{editPreview && <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>{editPreview}</span>}
									<textarea aria-label="Edit prompt" value={editPrompt} onChange={e => setEditPrompt(e.target.value)} rows={2} />
									<div style={{ display: "flex", gap: 6 }}>
										<button type="button" className="btn btn-primary" onClick={async () => { await apiPatch(`/api/cron/jobs/${j.id}`, { cron_expr: editCron, prompt: editPrompt }); setEditing(null); void refresh(); }}>Save</button>
										<button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
									</div>
								</div>
							) : (
								<>
									<span style={{ flex: 1, minWidth: 180 }}><strong>{j.name}</strong> <code style={{ background: "var(--panel)", padding: "2px 6px", borderRadius: 4 }}>{j.cron_expr}</code> <span className={`badge ${j.enabled ? "badge-success" : ""}`}>{j.enabled ? "enabled" : "disabled"}</span> {j.model ? <span className="badge">{j.model}</span> : null}</span>
									<button type="button" className="btn" onClick={() => { setEditing(j.id); setEditCron(j.cron_expr); setEditPrompt(j.prompt); }}>Edit</button>
									<button type="button" className="btn" onClick={async () => { await apiPatch(`/api/cron/jobs/${j.id}`, { enabled: j.enabled ? 0 : 1 }); void refresh(); }}>{j.enabled ? "Disable" : "Enable"}</button>
									<button type="button" className="btn btn-primary" onClick={async () => { await apiPost(`/api/cron/jobs/${j.id}/trigger`, {}); setTimeout(() => void refresh(), 1500); }}>Run now</button>
									<button type="button" className="btn" onClick={async () => { if (!confirm(`Delete job "${j.name}"?`)) return; await apiDelete(`/api/cron/jobs/${j.id}`); void refresh(); }}>Delete</button>
									<div style={{ width: "100%", fontSize: "var(--text-sm)", color: "var(--muted)" }}>{j.prompt.slice(0, 160)}</div>
								</>
							)}
						</div>
					))}
				</div>
			)}
			<h3 style={{ marginTop: 24 }}>Recent runs</h3>
			{runs.length === 0 ? <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}>No runs yet.</p> : (
				<div style={{ display: "grid", gap: 6 }}>
					{runs.slice(0, 20).map(r => (
						<details key={r.id} className="card" style={{ padding: "8px 12px" }}>
							<summary style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
								<span className={`badge ${r.status === "success" ? "badge-success" : r.status === "error" ? "badge-error" : r.status === "running" ? "badge-running" : "badge-warn"}`}>{r.status}</span>
								<span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>{r.started_at.slice(0, 19).replace("T", " ")} · {r.job_id.slice(0, 8)}</span>
								{r.output && <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{r.output.slice(0, 80)}</span>}
							</summary>
							{r.output && <pre style={{ marginTop: 8, background: "var(--panel)", padding: 8, borderRadius: 6, overflow: "auto", maxHeight: 300, whiteSpace: "pre-wrap", fontSize: "var(--text-sm)" }}>{r.output.slice(0, 5000)}</pre>}
						</details>
					))}
				</div>
			)}
		</div>
	);
}
