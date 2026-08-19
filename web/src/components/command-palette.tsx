import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
	id: string;
	label: string;
	hint?: string;
	action(): void;
}

export function CommandPalette({
	commands,
	onClose,
}: {
	commands: Command[];
	onClose(): void;
}): React.ReactElement {
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const [idx, setIdx] = useState(0);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const filtered = useMemo(() => {
		const q = query.toLowerCase();
		if (!q) return commands;
		return commands.filter(
			(c) =>
				c.label.toLowerCase().includes(q) ||
				(c.hint ?? "").toLowerCase().includes(q),
		);
	}, [commands, query]);

	useEffect(() => {
		setIdx(0);
	}, []);

	const run = (c: Command) => {
		onClose();
		c.action();
	};

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
			onClick={onClose}
			style={{
				position: "fixed",
				inset: 0,
				background: "oklch(0 0 0 / 0.4)",
				display: "flex",
				justifyContent: "center",
				paddingTop: 80,
				zIndex: 50,
			}}
		>
			<div
				onClick={(e) => e.stopPropagation()}
				className="card"
				style={{
					width: "min(560px, 92vw)",
					maxHeight: "60vh",
					display: "flex",
					flexDirection: "column",
					padding: 0,
					overflow: "hidden",
				}}
			>
				<input
					ref={inputRef}
					aria-label="Search commands"
					placeholder="Type a command…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown") {
							e.preventDefault();
							setIdx((i) => Math.min(i + 1, filtered.length - 1));
						} else if (e.key === "ArrowUp") {
							e.preventDefault();
							setIdx((i) => Math.max(i - 1, 0));
						} else if (e.key === "Enter" && filtered[idx]) run(filtered[idx]);
					}}
					style={{
						border: "none",
						borderBottom: "1px solid var(--border)",
						borderRadius: 0,
						padding: "12px 14px",
					}}
				/>
				<div style={{ overflow: "auto" }}>
					{filtered.length === 0 ? (
						<p style={{ padding: 14, color: "var(--muted)" }}>No matches</p>
					) : (
						filtered.map((c, i) => (
							<button
								key={c.id}
								type="button"
								onClick={() => run(c)}
								style={{
									display: "flex",
									justifyContent: "space-between",
									width: "100%",
									textAlign: "start",
									padding: "10px 14px",
									background: i === idx ? "var(--panel)" : "transparent",
									border: "none",
									cursor: "pointer",
								}}
							>
								<span>{c.label}</span>
								<span
									style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}
								>
									{c.hint ?? ""}
								</span>
							</button>
						))
					)}
				</div>
			</div>
		</div>
	);
}
