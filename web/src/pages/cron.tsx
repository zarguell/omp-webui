import React, { useEffect, useMemo, useState } from "react";
import cronstrue from "cronstrue";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";

interface Job {
	id: string;
	name: string;
	cron_expr: string;
	prompt: string;
	model?: string | null;
	enabled: number;
	project_id?: string | null;
	cwd?: string | null;
	kind?: string | null;
	script_source?: string | null;
	script?: string | null;
	script_args?: string | null;
	trigger?: string | null;
	webhook_token?: string | null;
	webhookPath?: string | null;
}

const labelStyle: React.CSSProperties = { display: "grid", gap: 4 };
const labelHeadStyle: React.CSSProperties = { fontSize: "var(--text-xs)", color: "var(--muted)", fontWeight: 600 };

export function CronPage(): React.ReactElement {
	const [jobs, setJobs] = useState<Job[]>([]);
	const [runs, setRuns] = useState<{ id: string; job_id: string; status: string; started_at: string; output?: string | null }[]>([]);
	const [loading, setLoading] = useState(true);
	const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
	const [name, setName] = useState("");
	const [cron, setCron] = useState("0 * * * *");
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState("");
	const [projectId, setProjectId] = useState("");
	const [kind, setKind] = useState<"prompt" | "script">("prompt");
	const [scriptSource, setScriptSource] = useState<"inline" | "file">("inline");
	const [script, setScript] = useState("");
	const [scriptArgs, setScriptArgs] = useState("");
	const [trigger, setTrigger] = useState<"schedule" | "webhook">("schedule");
	const [webhookPort, setWebhookPort] = useState<number>(8788);
	const [editing, setEditing] = useState<string | null>(null);
	const [editCron, setEditCron] = useState("");
	const [editPrompt, setEditPrompt] = useState("");
	const [err, setErr] = useState("");

	const refresh = async () => {
		setLoading(true);
		try {
			const [j, r, p, s] = await Promise.all([
				apiGet("/api/cron/jobs"),
				apiGet("/api/cron/runs"),
				apiGet("/api/projects").catch(() => []),
				apiGet("/api/settings").catch(() => ({})),
			]);
			setJobs(j as Job[]); setRuns(r as typeof runs); setProjects((p as typeof projects) ?? []);
			const port = (s as { webhookPort?: number }).webhookPort;
			if (typeof port === "number") setWebhookPort(port);
		} catch (e) { setErr(String(e)); } finally { setLoading(false); }
	};
	useEffect(() => { void refresh(); }, []);

	const preview = useMemo(() => {
		if (trigger === "webhook" || !cron.trim()) return "";
		try {
			return cronstrue.toString(cron);
		} catch { return ""; }
	}, [cron, trigger]);

	const editPreview = useMemo(() => {
		try {
			return editCron ? cronstrue.toString(editCron) : "";
		} catch { return ""; }
	}, [editCron]);

	const canSubmit =
		!!name.trim() &&
		(trigger === "webhook" || !!cron.trim()) &&
		(kind === "script"
			? !!script.trim() && (scriptSource === "inline" || !!script.trim())
			: !!prompt.trim());

	const submit = async () => {
		setErr("");
		const parsedArgs = scriptArgs.split(",").map(s => s.trim()).filter(s => s !== "");
		const body: Record<string, unknown> = {
			name,
			trigger,
			kind,
			model: model || undefined,
			projectId: projectId || undefined,
		};
		if (kind === "script") {
			body.scriptSource = scriptSource;
			body.script = script;
			body.scriptArgs = parsedArgs;
		} else {
			body.prompt = prompt;
		}
		if (trigger === "schedule") body.cron = cron;
		try {
			await apiPost("/api/cron/jobs", body);
			setName(""); setPrompt(""); setScript(""); setScriptArgs("");
			void refresh();
		} catch (e) { setErr(String(e)); }
	};

	return (
		<div>
			<h2 style={{ marginTop: 0 }}>Cron</h2>
			<p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", marginTop: -8 }}>Supercronic — crontab at <code>/data/crontab</code>. Webhook jobs are triggered via <code>POST :{webhookPort}/hook/&lt;id&gt;/&lt;token&gt;</code>.</p>
			<div className="card" style={{ marginBottom: 16, display: "grid", gap: 8 }}>
				<label style={labelStyle}><span style={labelHeadStyle}>Name</span><input aria-label="Job name" placeholder="hourly check" value={name} onChange={e => setName(e.target.value)} /></label>
				<div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
					<label style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="radio" name="job-kind" checked={kind === "prompt"} onChange={() => setKind("prompt")} /> Prompt</label>
					<label style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="radio" name="job-kind" checked={kind === "script"} onChange={() => setKind("script")} /> Script</label>
				</div>
				{kind === "prompt" && (
					<label style={labelStyle}><span style={labelHeadStyle}>Prompt</span><textarea aria-label="Prompt" placeholder="prompt for omp --mode json -p" value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} /></label>
				)}
				{kind === "script" && (
					<>
						<label style={labelStyle}><span style={labelHeadStyle}>Script source</span>
							<select aria-label="Script source" value={scriptSource} onChange={e => setScriptSource(e.target.value as "inline" | "file")}>
								<option value="inline">Inline</option>
								<option value="file">File</option>
							</select>
						</label>
						{scriptSource === "inline" ? (
							<label style={labelStyle}><span style={labelHeadStyle}>Script (bash)</span><textarea aria-label="Script" placeholder="echo hello $1" value={script} onChange={e => setScript(e.target.value)} rows={3} /></label>
						) : (
							<label style={labelStyle}><span style={labelHeadStyle}>Script file (absolute path)</span><input aria-label="Script file" placeholder="/opt/scripts/deploy.sh" value={script} onChange={e => setScript(e.target.value)} /></label>
						)}
						<label style={labelStyle}><span style={labelHeadStyle}>Args (comma-separated)</span><input aria-label="Script args" placeholder="--verbose, name" value={scriptArgs} onChange={e => setScriptArgs(e.target.value)} /></label>
					</>
				)}
				<div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
					<label style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="radio" name="job-trigger" checked={trigger === "schedule"} onChange={() => setTrigger("schedule")} /> Schedule</label>
					<label style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="radio" name="job-trigger" checked={trigger === "webhook"} onChange={() => setTrigger("webhook")} /> Webhook</label>
				</div>
				{trigger === "schedule" && (
					<label style={labelStyle}><span style={labelHeadStyle}>Cron</span><input aria-label="Cron expression" placeholder="0 * * * *" value={cron} onChange={e => setCron(e.target.value)} /></label>
				)}
				{preview && <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>{preview}</span>}
				<label style={labelStyle}><span style={labelHeadStyle}>Project</span>
					<select aria-label="Project" value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">— none —</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
				</label>
				<label style={labelStyle}><span style={labelHeadStyle}>Model (optional)</span><input aria-label="Model" placeholder="anthropic/claude-sonnet-4-20250514" value={model} onChange={e => setModel(e.target.value)} /></label>
				{err && <span style={{ color: "var(--error)", fontSize: "var(--text-sm)" }}>{err}</span>}
				<button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
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
									<span style={{ flex: 1, minWidth: 180 }}><strong>{j.name}</strong> {j.cron_expr ? <code style={{ background: "var(--panel)", padding: "2px 6px", borderRadius: 4 }}>{j.cron_expr}</code> : <span className="badge">webhook</span>} {j.kind === "script" ? <span className="badge">script</span> : null} <span className={`badge ${j.enabled ? "badge-success" : ""}`}>{j.enabled ? "enabled" : "disabled"}</span> {j.model ? <span className="badge">{j.model}</span> : null}</span>
									{j.trigger === "webhook" && j.webhookPath && (
										<>
											<code style={{ background: "var(--panel)", padding: "2px 6px", borderRadius: 4, fontSize: "var(--text-xs)" }} title={`http://<host>:${webhookPort}${j.webhookPath}`}>{j.webhookPath}</code>
											<button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(j.webhookPath ?? "")}>Copy</button>
											<button type="button" className="btn" onClick={async () => { await apiPost(`/api/cron/jobs/${j.id}/rotate-token`, {}); void refresh(); }}>Rotate</button>
										</>
									)}
									<button type="button" className="btn" onClick={() => { setEditing(j.id); setEditCron(j.cron_expr); setEditPrompt(j.prompt); }}>Edit</button>
									<button type="button" className="btn" onClick={async () => { await apiPatch(`/api/cron/jobs/${j.id}`, { enabled: j.enabled ? 0 : 1 }); void refresh(); }}>{j.enabled ? "Disable" : "Enable"}</button>
									<button type="button" className="btn btn-primary" onClick={async () => { await apiPost(`/api/cron/jobs/${j.id}/trigger`, {}); setTimeout(() => void refresh(), 1500); }}>Run now</button>
									<button type="button" className="btn" onClick={async () => { if (!confirm(`Delete job "${j.name}"?`)) return; await apiDelete(`/api/cron/jobs/${j.id}`); void refresh(); }}>Delete</button>
									<div style={{ width: "100%", fontSize: "var(--text-sm)", color: "var(--muted)" }}>
										{j.kind === "script" ? <code style={{ background: "var(--panel)", padding: "2px 6px", borderRadius: 4 }}>{j.script_source === "file" ? j.script : (j.script ?? "").slice(0, 160)}</code> : j.prompt.slice(0, 160)}
									</div>
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
