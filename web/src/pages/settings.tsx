import React, { useEffect, useState } from "react";
import { apiGet, apiPut } from "../lib/api";

export function SettingsPage(): React.ReactElement {
	const [settings, setSettings] = useState<Record<string, unknown>>({});
	const [schema, setSchema] = useState<{ tabs?: string[]; schema?: Record<string, unknown> }>({});
	const [path, setPath] = useState("modelRoles.default");
	const [value, setValue] = useState("");
	const [msg, setMsg] = useState("");

	useEffect(() => {
		apiGet("/api/settings").then(v => setSettings(v as Record<string, unknown>)).catch(() => {});
		apiGet("/api/settings/schema").then(v => setSchema(v as typeof schema)).catch(() => {});
	}, []);

	return (
		<div>
			<h2>Settings</h2>
			<details style={{ marginBottom: 12 }}>
				<summary>Current config.yml (raw)</summary>
				<pre style={{ background: "#f6f6f6", padding: 12, overflow: "auto", maxHeight: 300 }}>{JSON.stringify(settings, null, 2)}</pre>
			</details>
			{schema.tabs && schema.tabs.length > 0 && <p style={{ fontSize: 12, color: "#666" }}>Tabs: {schema.tabs.join(", ")}</p>}
			<div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
				<input placeholder="path (e.g. modelRoles.default)" value={path} onChange={e => setPath(e.target.value)} style={{ flex: 1 }} />
				<input placeholder='value (JSON, e.g. "anthropic/claude-sonnet-4-20250514")' value={value} onChange={e => setValue(e.target.value)} style={{ flex: 1 }} />
				<button
					type="button"
					onClick={async () => {
						setMsg("");
						try {
							let parsed: unknown = value;
							try { parsed = JSON.parse(value); } catch {}
							await apiPut("/api/settings", { path, value: parsed });
							setMsg("Saved");
							apiGet("/api/settings").then(v => setSettings(v as Record<string, unknown>)).catch(() => {});
						} catch (e) { setMsg(String(e)); }
					}}
				>
					Save
				</button>
			</div>
			{msg && <p style={{ fontSize: 12 }}>{msg}</p>}
			<p style={{ fontSize: 12, color: "#666" }}>Or use the Terminal tab: <code>omp config set {path} value</code> / <code>vim ~/.omp/agent/config.yml</code></p>
		</div>
	);
}
