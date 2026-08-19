import type React from "react";
import { useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../lib/api";

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function SecretsPage(): React.ReactElement {
	const [secrets, setSecrets] = useState<
		{ id: string; name: string; created_at: string }[]
	>([]);
	const [loading, setLoading] = useState(true);
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [showValue, setShowValue] = useState(false);
	const [err, setErr] = useState("");
	const [toast, setToast] = useState("");

	const refresh = async () => {
		setLoading(true);
		try {
			setSecrets((await apiGet("/api/secrets")) as typeof secrets);
		} catch (e) {
			setErr(String(e));
		} finally {
			setLoading(false);
		}
	};
	useEffect(() => {
		void refresh();
	}, [refresh]);

	const validName = !name || ENV_RE.test(name);
	const canAdd = name.trim() && value && validName;

	return (
		<div>
			<h2 style={{ marginTop: 0 }}>Secrets</h2>
			<p
				style={{
					color: "var(--muted)",
					fontSize: "var(--text-sm)",
					marginTop: -8,
				}}
			>
				AES-256-GCM at rest in <code>omp-webui.db</code>, injected as{" "}
				<code>$ENV</code> into every omp spawn + terminal. Back up{" "}
				<code>/data/keys/master.key</code>.
			</p>
			<div className="card" style={{ marginBottom: 16 }}>
				<div
					style={{
						display: "flex",
						gap: 8,
						flexWrap: "wrap",
						alignItems: "end",
					}}
				>
					<label style={{ flex: 1, minWidth: 200, display: "grid", gap: 4 }}>
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
							aria-label="Secret name"
							placeholder="ANTHROPIC_API_KEY"
							value={name}
							onChange={(e) => setName(e.target.value.toUpperCase())}
						/>
						{!validName && (
							<span
								style={{ color: "var(--error)", fontSize: "var(--text-xs)" }}
							>
								Must match [A-Za-z_][A-Za-z0-9_]*
							</span>
						)}
					</label>
					<label style={{ flex: 1, minWidth: 200, display: "grid", gap: 4 }}>
						<span
							style={{
								fontSize: "var(--text-xs)",
								color: "var(--muted)",
								fontWeight: 600,
							}}
						>
							Value
						</span>
						<div style={{ display: "flex", gap: 4 }}>
							<input
								aria-label="Secret value"
								placeholder="sk-…"
								type={showValue ? "text" : "password"}
								value={value}
								onChange={(e) => setValue(e.target.value)}
								style={{ flex: 1 }}
							/>
							<button
								type="button"
								className="btn"
								onClick={() => setShowValue((v) => !v)}
							>
								{showValue ? "Hide" : "Show"}
							</button>
						</div>
					</label>
					<button
						type="button"
						className="btn btn-primary"
						disabled={!canAdd}
						onClick={async () => {
							setErr("");
							setToast("");
							try {
								await apiPost("/api/secrets", { name: name.trim(), value });
								setName("");
								setValue("");
								setToast("Secret saved");
								void refresh();
								setTimeout(() => setToast(""), 2000);
							} catch (e) {
								setErr(String(e));
							}
						}}
					>
						Add
					</button>
				</div>
				{err && (
					<p
						style={{
							color: "var(--error)",
							fontSize: "var(--text-sm)",
							marginTop: 8,
						}}
					>
						{err}
					</p>
				)}
				{toast && (
					<p
						aria-live="polite"
						style={{
							color: "var(--success)",
							fontSize: "var(--text-sm)",
							marginTop: 8,
						}}
					>
						{toast}
					</p>
				)}
			</div>
			{loading ? (
				<div className="skeleton" style={{ height: 48 }} />
			) : secrets.length === 0 ? (
				<div
					className="card"
					style={{ textAlign: "center", color: "var(--muted)" }}
				>
					No secrets yet — add <code>ANTHROPIC_API_KEY</code>,{" "}
					<code>OPENAI_API_KEY</code>, etc.
				</div>
			) : (
				<div style={{ display: "grid", gap: 8 }}>
					{secrets.map((s) => (
						<div
							key={s.id}
							className="card"
							style={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								gap: 12,
								padding: "10px 12px",
							}}
						>
							<span>
								<code>{s.name}</code>{" "}
								<span
									style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}
								>
									{s.created_at.slice(0, 19).replace("T", " ")}
								</span>
							</span>
							<button
								type="button"
								className="btn"
								onClick={async () => {
									if (
										!confirm(
											`Delete secret "${s.name}"? This breaks all spawns using it.`,
										)
									)
										return;
									await apiDelete(`/api/secrets/${s.id}`);
									void refresh();
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
