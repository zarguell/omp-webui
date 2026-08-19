import type React from "react";
import { useState } from "react";

export function ApprovalDialog({
	pending,
	respond,
}: {
	pending: { id: string; method: string; title?: string; options?: string[] };
	respond: (r: { value: string } | { confirmed: boolean } | { cancelled: true }) => Promise<void>;
}): React.ReactElement {
	const [inFlight, setInFlight] = useState(false);
	const [inputValue, setInputValue] = useState("");

	const handleRespond = async (r: { value: string } | { confirmed: boolean } | { cancelled: true }) => {
		setInFlight(true);
		try {
			await respond(r);
		} finally {
			setInFlight(false);
		}
	};

	return (
		<div
			style={{
				position: "sticky",
				bottom: 0,
				zIndex: 10,
				padding: "12px 16px",
				background: "var(--surface)",
				borderTop: "2px solid var(--warning)",
				display: "flex",
				flexDirection: "column",
				gap: 8,
			}}
		>
			{pending.title && (
				<pre
					style={{
						fontSize: "var(--text-sm)",
						fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
						margin: 0,
						color: "var(--text)",
					}}
				>
					{pending.title}
				</pre>
			)}
			{pending.method === "select" && pending.options && (
				<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
					{pending.options.map((opt) => (
						<button
							key={opt}
							type="button"
							className="btn btn-primary"
							disabled={inFlight}
							onClick={() => void handleRespond({ value: opt })}
						>
							{opt}
						</button>
					))}
				</div>
			)}
			{pending.method === "confirm" && (
				<div style={{ display: "flex", gap: 8 }}>
					<button
						type="button"
						className="btn btn-primary"
						disabled={inFlight}
						onClick={() => void handleRespond({ confirmed: true })}
					>
						OK
					</button>
					<button
						type="button"
						className="btn"
						disabled={inFlight}
						onClick={() => void handleRespond({ confirmed: false })}
					>
						Cancel
					</button>
				</div>
			)}
			{pending.method === "input" && (
				<div style={{ display: "flex", gap: 8 }}>
					<input
						aria-label="Approval input"
						value={inputValue}
						onChange={(e) => setInputValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && inputValue.trim()) {
								void handleRespond({ value: inputValue });
							}
						}}
						style={{ flex: 1 }}
						disabled={inFlight}
					/>
					<button
						type="button"
						className="btn btn-primary"
						disabled={inFlight || !inputValue.trim()}
						onClick={() => void handleRespond({ value: inputValue })}
					>
						Submit
					</button>
					<button
						type="button"
						className="btn"
						disabled={inFlight}
						onClick={() => void handleRespond({ cancelled: true })}
					>
						Cancel
					</button>
				</div>
			)}
		</div>
	);
}
