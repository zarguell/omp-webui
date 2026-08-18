import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./tokens.css";
import { CommandPalette, type Command } from "./components/command-palette";
import { ChatPage } from "./pages/chat";
import { CronPage } from "./pages/cron";
import { ProjectsPage } from "./pages/projects";
import { SecretsPage } from "./pages/secrets";
import { SessionsPage } from "./pages/sessions";
import { SettingsPage } from "./pages/settings";
import { TerminalPage } from "./pages/terminal";

type Tab = "sessions" | "terminal" | "projects" | "secrets" | "cron" | "settings";

const TABS: { id: Tab; label: string; icon: string }[] = [
	{ id: "sessions", label: "Sessions", icon: "💬" },
	{ id: "terminal", label: "Terminal", icon: "⬛" },
	{ id: "projects", label: "Projects", icon: "📁" },
	{ id: "secrets", label: "Secrets", icon: "🔑" },
	{ id: "cron", label: "Cron", icon: "⏰" },
	{ id: "settings", label: "Settings", icon: "⚙" },
];

export function App(): React.ReactElement {
	const [tab, setTab] = useState<Tab>("sessions");
	const [palette, setPalette] = useState(false);
	const [chatSessionId, setChatSessionId] = useState<string | null>(null);

	const openChat = useCallback((id: string) => {
		setChatSessionId(id);
	}, []);

	const closeChat = useCallback(() => {
		setChatSessionId(null);
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(v => !v); }
			if (e.key === "Escape" && chatSessionId) { e.preventDefault(); closeChat(); }
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [chatSessionId, closeChat]);

	const commands: Command[] = useMemo(() => TABS.map(t => ({
		id: `nav-${t.id}`,
		label: `Go to ${t.label}`,
		hint: `Tab`,
		action: () => { setChatSessionId(null); setTab(t.id); },
	})), []);

	const nav = (
		<nav aria-label="Primary">
			<p className="nav-title">omp-webui</p>
			<p className="nav-sub">headless omp · ⌘K</p>
			{TABS.map(t => (
				<button
					key={t.id}
					type="button"
					className="nav-item"
					aria-current={tab === t.id ? "page" : undefined}
					onClick={() => { setChatSessionId(null); setTab(t.id); }}
				>
					<span className="nav-icon" aria-hidden="true">{t.icon}</span>
					<span className="nav-label">{t.label}</span>
				</button>
			))}
		</nav>
	);

	// Full-screen chat view
	if (chatSessionId) {
		return (
			<div className="shell">
				{nav}
				<main style={{ padding: 0, maxWidth: "none" }}>
					<ChatPage sessionId={chatSessionId} onBack={closeChat} />
				</main>
				{palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
			</div>
		);
	}

	return (
		<div className="shell">
			{nav}
			<main>
				{tab === "sessions" && <SessionsPage onOpenChat={openChat} />}
				{tab === "terminal" && <TerminalPage />}
				{tab === "projects" && <ProjectsPage />}
				{tab === "secrets" && <SecretsPage />}
				{tab === "cron" && <CronPage />}
				{tab === "settings" && <SettingsPage />}
			</main>
			{palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
		</div>
	);
}
