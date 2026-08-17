import React, { useState } from "react";
import { CronPage } from "./pages/cron";
import { ProjectsPage } from "./pages/projects";
import { SecretsPage } from "./pages/secrets";
import { SessionsPage } from "./pages/sessions";
import { SettingsPage } from "./pages/settings";
import { TerminalPage } from "./pages/terminal";

type Tab = "sessions" | "terminal" | "projects" | "secrets" | "cron" | "settings";

export function App(): React.ReactElement {
	const [tab, setTab] = useState<Tab>("sessions");
	return (
		<div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 960, margin: "0 auto", padding: 16 }}>
			<h1 style={{ fontSize: 20, marginBottom: 8 }}>omp-webui</h1>
			<nav style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
				{(["sessions", "terminal", "projects", "secrets", "cron", "settings"] as Tab[]).map(t => (
					<button
						key={t}
						type="button"
						onClick={() => setTab(t)}
						style={{
							padding: "6px 12px",
							border: "1px solid #ccc",
							borderRadius: 6,
							background: tab === t ? "#111" : "#fff",
							color: tab === t ? "#fff" : "#111",
							cursor: "pointer",
						}}
					>
						{t}
					</button>
				))}
			</nav>
			{tab === "sessions" && <SessionsPage />}
			{tab === "terminal" && <TerminalPage />}
			{tab === "projects" && <ProjectsPage />}
			{tab === "secrets" && <SecretsPage />}
			{tab === "cron" && <CronPage />}
			{tab === "settings" && <SettingsPage />}
		</div>
	);
}
