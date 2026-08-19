import type React from "react";
import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";

export function ProjectsPage(): React.ReactElement {
	const [projects, setProjects] = useState<
		{ id: string; name: string; cwd: string; default_model?: string | null; approval_mode?: string | null }[]
	>([]);
	const [loading, setLoading] = useState(true);
	const [name, setName] = useState("");
	const [cwd, setCwd] = useState("");
	const [approvalMode, setApprovalMode] = useState("");
	const [err, setErr] = useState("");

	const refresh = async (silent = false) => {
		if (!silent) setLoading(true);
		try {
			setProjects((await apiGet("/api/projects")) as typeof projects);
		} catch (e) {
			setErr(String(e));
		} finally {
			setLoading(false);
		}
	};
	useEffect(() => {
		void refresh();
	}, []);

	return (
		<div>
			<h2 style={{ marginTop: 0 }}>Projects</h2>
			<div
				className="card"
				style={{
					marginBottom: 16,
					display: "flex",
					gap: 8,
					flexWrap: "wrap",
					alignItems: "end",
				}}
			>
				<label style={{ flex: "1 1 160px", display: "grid", gap: 4 }}>
					<span
						style={{
							fontSize: "var(--text-xs)",
							color: "var(--muted)",
							fontWeight: 600,
						}}
					>
						Name
					</span>
					<input
						aria-label="Project name"
						placeholder="my-app"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
				</label>
				<label style={{ flex: "2 1 260px", display: "grid", gap: 4 }}>
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
						aria-label="Project cwd"
						placeholder="/data/workspaces/my-app"
						value={cwd}
						onChange={(e) => setCwd(e.target.value)}
					/>
				</label>
				<label style={{ flex: "1 1 140px", display: "grid", gap: 4 }}>
					<span
						style={{
							fontSize: "var(--text-xs)",
							color: "var(--muted)",
							fontWeight: 600,
						}}
					>
						Approval
					</span>
					<select
						aria-label="Approval mode"
						value={approvalMode}
						onChange={(e) => setApprovalMode(e.target.value)}
					>
						<option value="">Default</option>
						<option value="always-ask">always-ask</option>
						<option value="write">write</option>
						<option value="yolo">yolo</option>
					</select>
				</label>
				<button
					type="button"
					className="btn btn-primary"
					disabled={!name.trim() || !cwd.trim()}
					onClick={async () => {
						setErr("");
						try {
							await apiPost("/api/projects", {
								name,
								cwd,
								approval_mode: approvalMode || undefined,
							});
							setName("");
							setCwd("");
							setApprovalMode("");
							void refresh(true);
						} catch (e) {
							setErr(String(e));
						}
					}}
				>
					Add
				</button>
			</div>
			{err && (
				<div
					className="card"
					style={{
						borderColor: "var(--error)",
						color: "var(--error)",
						marginBottom: 12,
					}}
				>
					{err}
				</div>
			)}
			{loading ? (
				<div className="skeleton" style={{ height: 48 }} />
			) : projects.length === 0 ? (
				<div
					className="card"
					style={{ textAlign: "center", color: "var(--muted)" }}
				>
					No projects — add one to scope sessions and cron.
				</div>
			) : (
				<div style={{ display: "grid", gap: 8 }}>
					{projects.map((p) => (
						<div
							key={p.id}
							className="card"
							style={{
								display: "flex",
								justifyContent: "space-between",
								gap: 12,
								alignItems: "center",
								padding: "10px 12px",
							}}
						>
							<span>
								<strong>{p.name}</strong>{" "}
								<span
									style={{ color: "var(--muted)", fontSize: "var(--text-sm)" }}
								>
									{p.cwd}
								</span>{" "}
								{p.default_model ? (
									<span className="badge">{p.default_model}</span>
								) : null}
								{p.approval_mode ? (
									<span className="badge" style={{ borderColor: "var(--warning)" }}>
										{p.approval_mode}
									</span>
								) : null}
							</span>
							<button
								type="button"
								className="btn"
								onClick={async () => {
									if (
										!confirm(
											`Delete project "${p.name}"? Cron jobs referencing it will be orphaned.`,
										)
									)
										return;
									await apiDelete(`/api/projects/${p.id}`);
									void refresh(true);
								}}
							>
								Delete
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
