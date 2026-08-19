import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export function TerminalView({
	terminalId,
}: {
	terminalId: string;
}): React.ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<{ focus(): void } | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const [status, setStatus] = useState<"connecting" | "open" | "closed">(
		"connecting",
	);

	const fitAndResize = useCallback(
		(
			fitAddon: {
				fit(): void;
				proposeDimensions?(): { cols: number; rows: number } | undefined;
			},
			ws: WebSocket | null,
		) => {
			try {
				fitAddon.fit();
				const dims = fitAddon.proposeDimensions?.();
				if (dims && ws?.readyState === WebSocket.OPEN)
					ws.send(
						JSON.stringify({
							type: "resize",
							cols: dims.cols,
							rows: dims.rows,
						}),
					);
			} catch {}
		},
		[],
	);

	useEffect(() => {
		let disposed = false;
		let term: { dispose(): void; focus(): void } | null = null;
		let ws: WebSocket | null = null;
		let ro: ResizeObserver | null = null;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		let resizeTimer: ReturnType<typeof setTimeout> | null = null;
		let fitAddon: {
			fit(): void;
			proposeDimensions?(): { cols: number; rows: number } | undefined;
		} | null = null;

		const connect = async () => {
			const { Terminal } = await import("xterm");
			await import("xterm/css/xterm.css" as string);
			const { FitAddon } = await import("xterm-addon-fit");
			if (disposed || !containerRef.current) return;

			const t = new Terminal({
				cursorBlink: true,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				fontSize: 13,
				theme: { background: "#111", foreground: "#eee" },
				allowProposedApi: true,
				scrollback: 10000,
			});
			const fit = new FitAddon();
			t.loadAddon(fit);
			fitAddon = fit;
			t.open(containerRef.current);
			term = t;
			termRef.current = t;

			// Auto-focus so typing works immediately
			setTimeout(() => {
				if (!disposed) t.focus();
			}, 100);

			// Delay fit until DOM layout has settled
			const doFit = () => {
				if (!disposed) fitAndResize(fit, ws);
			};
			// Double-RAF ensures the browser has painted the container
			requestAnimationFrame(() => requestAnimationFrame(doFit));

			const openWs = () => {
				if (disposed) return;
				const proto = location.protocol === "https:" ? "wss:" : "ws:";
				ws = new WebSocket(
					`${proto}//${location.host}/api/terminals/${terminalId}/ws`,
				);
				wsRef.current = ws;
				ws.onopen = () => {
					setStatus("open");
					doFit();
				};
				ws.onclose = () => {
					setStatus("closed");
					if (!disposed) reconnectTimer = setTimeout(openWs, 1500);
				};
				ws.onerror = () => setStatus("closed");
				ws.onmessage = (ev) => {
					try {
						const msg = JSON.parse(
							typeof ev.data === "string"
								? ev.data
								: new TextDecoder().decode(ev.data as ArrayBuffer),
						);
						if (msg.type === "output" && typeof msg.data === "string")
							t.write(msg.data);
						if (msg.type === "exit")
							t.write(`\r\n[exit ${msg.exitCode ?? ""}]\r\n`);
					} catch {
						if (typeof ev.data === "string") t.write(ev.data);
					}
				};
			};
			openWs();

			t.onData((data: string) => {
				if (ws?.readyState === WebSocket.OPEN)
					ws.send(JSON.stringify({ type: "input", data }));
			});

			ro = new ResizeObserver(() => {
				if (resizeTimer) clearTimeout(resizeTimer);
				resizeTimer = setTimeout(() => {
					if (fitAddon && !disposed) fitAndResize(fitAddon, ws);
				}, 150);
			});
			ro.observe(containerRef.current);
		};
		void connect();

		return () => {
			disposed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (resizeTimer) clearTimeout(resizeTimer);
			try {
				ro?.disconnect();
			} catch {}
			try {
				ws?.close();
			} catch {}
			try {
				term?.dispose();
			} catch {}
			termRef.current = null;
		};
	}, [terminalId, fitAndResize]);

	return (
		<div>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: 8,
				}}
			>
				<span
					aria-live="polite"
					className={`badge ${status === "open" ? "badge-success" : status === "closed" ? "badge-error" : "badge-running"}`}
				>
					{status}
				</span>
				<span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
					{terminalId.slice(0, 8)}
				</span>
				<div style={{ flex: 1 }} />
				<button
					type="button"
					className="btn btn-ghost"
					onClick={async () => {
						try {
							const text = await navigator.clipboard.readText();
							if (text && wsRef.current?.readyState === WebSocket.OPEN) {
								wsRef.current.send(JSON.stringify({ type: "input", data: text }));
								termRef.current?.focus();
							}
						} catch {}
					}}
					style={{ fontSize: "var(--text-xs)", padding: "4px 8px" }}
					title="Paste from clipboard"
				>
					Paste
				</button>
			</div>
			<div
				ref={containerRef}
				role="application"
				aria-label="Terminal"
				style={{
					background: "#111",
					padding: 4,
					height: 500,
					borderRadius: 8,
					outline: "none",
					overflow: "hidden",
				}}
				onClick={() => termRef.current?.focus()}
			/>
		</div>
	);
}
