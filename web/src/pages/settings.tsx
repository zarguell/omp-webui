import React, { useEffect, useState } from "react";
import { apiGet, apiPut } from "../lib/api";

export function SettingsPage(): React.ReactElement {
	const [settings, setSettings] = useState<Record<string, unknown>>({});
	const [loading, setLoading] = useState(true);
	const [path, setPath] = useState("modelRoles.default");
	const [value, setValue] = useState("");
	const [msg, setMsg] = useState("");

	const refresh = async () => {
		setLoading(true);
		try { setSettings((await apiGet("/api/settings")) as Record<string, unknown>); } catch {} finally { setLoading(false); }
	};
	useEffect(() => { void refresh(); }, []);

	return (
		<div>
			<h2 style={{ marginTop: 0 }}>Settings</h2>
			<div className="card" style={{ marginBottom: 16 }}>
				<details>
					<summary style={{ cursor: "pointer", fontWeight: 600 }}>Current config.yml (raw)</summary>
					<pre style={{ background: "var(--panel)", padding: 12, overflow: "auto", maxHeight: 300, borderRadius: 8, marginTop: 8 }}>{loading ? "Loading…" : JSON.stringify(settings, null, 2)}</pre>
				</details>
			</div>
			<div className="card" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
				<label style={{ flex: "1 1 200px", display: "grid", gap: 4 }}><span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", fontWeight: 600 }}>Path</span><input aria-label="Setting path" placeholder="modelRoles.default" value={path} onChange={e => setPath(e.target.value)} /></label>
				<label style={{ flex: "1 1 200px", display: "grid", gap: 4 }}><span style={{ fontSize: "var(--text-xs)", color: "var(--muted)", fontWeight: 600 }}>Value (JSON)</span><input aria-label="Setting value" placeholder='"anthropic/claude-sonnet-4-20250514"' value={value} onChange={e => setValue(e.target.value)} /></label>
				<button
					type="button"
					className="btn btn-primary"
					onClick={async () => {
						setMsg("");
						try {
							let parsed: unknown = value;
							try { parsed = JSON.parse(value); } catch {}
							await apiPut("/api/settings", { path, value: parsed });
							setMsg("Saved ✓");
							void refresh();
							setTimeout(() => setMsg(""), 2000);
						} catch (e) { setMsg(String(e)); }
					}}
				>
					Save
				</button>
			</div>
			{msg && <p aria-live="polite" style={{ fontSize: "var(--text-sm)", color: msg.includes("✓") ? "var(--success)" : "var(--error)" }}>{msg}</p>}
			<p style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>Or use the Terminal tab: <code>omp config set {path} value</code> or <code>vim ~/.omp/agent/config.yml</code>.</p>
		</div>
	);
}
