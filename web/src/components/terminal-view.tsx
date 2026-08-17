import React, { useEffect, useRef } from "react";

export function TerminalView({ terminalId }: { terminalId: string }): React.ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<{ focus(): void } | null>(null);

	useEffect(() => {
		let disposed = false;
		let term: { dispose(): void } | null = null;
		let ws: WebSocket | null = null;
		let ro: ResizeObserver | null = null;

		const init = async () => {
			const { Terminal } = await import("xterm");
			await import("xterm/css/xterm.css" as string);
			const { FitAddon } = await import("xterm-addon-fit");
			if (disposed || !containerRef.current) return;
			const t = new Terminal({ cursorBlink: true, fontFamily: "monospace", fontSize: 13, theme: { background: "#111", foreground: "#eee" } });
			const fit = new FitAddon();
			t.loadAddon(fit);
			t.open(containerRef.current);
			fit.fit();
			term = t;
			termRef.current = t as unknown as { focus(): void };

			const proto = location.protocol === "https:" ? "wss:" : "ws:";
			ws = new WebSocket(`${proto}//${location.host}/api/terminals/${terminalId}/ws`);
			ws.onmessage = ev => {
				try {
					const msg = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
					if (msg.type === "output" && typeof msg.data === "string") t.write(msg.data);
				} catch {
					if (typeof ev.data === "string") t.write(ev.data);
				}
			};
			t.onData((data: string) => {
				if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
			});
			ro = new ResizeObserver(() => {
				try {
					fit.fit();
					const dims = (fit as unknown as { proposeDimensions(): { cols: number; rows: number } | undefined }).proposeDimensions();
					if (dims && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
				} catch {}
			});
			ro.observe(containerRef.current);
		};
		void init();
		return () => {
			disposed = true;
			try { ro?.disconnect(); } catch {}
			try { ws?.close(); } catch {}
			try { term?.dispose(); } catch {}
			termRef.current = null;
		};
	}, [terminalId]);

	return <div ref={containerRef} style={{ background: "#111", padding: 8, minHeight: 400, borderRadius: 8 }} onClick={() => termRef.current?.focus()} />;
}
