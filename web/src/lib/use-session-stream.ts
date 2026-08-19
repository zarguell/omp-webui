import { useCallback, useEffect, useRef, useState } from "react";

export function useSessionStream(sessionId: string | null): {
	lines: string[];
	status: "loading" | "streaming" | "done";
	resetCount: number;
	clear: () => void;
} {
	const [lines, setLines] = useState<string[]>([]);
	const [status, setStatus] = useState<"loading" | "streaming" | "done">(
		"loading",
	);
	const [resetCount, setResetCount] = useState(0);
	const abortRef = useRef<AbortController | null>(null);
	const lastSeqRef = useRef(0);
	const lastActivityRef = useRef(Date.now());
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const activeRef = useRef(false);
	const statusRef = useRef<"loading" | "streaming" | "done">("loading");

	const clear = useCallback(() => {
		setLines([]);
		setStatus("loading");
		statusRef.current = "loading";
		setResetCount(0);
		lastSeqRef.current = 0;
	}, []);

	useEffect(() => {
		if (!sessionId) {
			setLines([]);
			setStatus("loading");
			statusRef.current = "loading";
			return;
		}

		activeRef.current = true;
		let active = true;

		const connect = () => {
			if (!active || !activeRef.current) return;
			abortRef.current?.abort();
			const ac = new AbortController();
			abortRef.current = ac;

			const afterParam = lastSeqRef.current > 0 ? `?afterSeq=${lastSeqRef.current}` : "";
			fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stream${afterParam}`, {
				signal: ac.signal,
			})
				.then((res) => {
					if (!res.body || !active) return;
					setStatus("streaming");
					statusRef.current = "streaming";
					lastActivityRef.current = Date.now();
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					let buf = "";
					const pump = (): Promise<void> =>
						reader.read().then(({ value, done }) => {
							if (done || !active) {
								setStatus("done");
								statusRef.current = "done";
								return;
							}
							lastActivityRef.current = Date.now();
							buf += decoder.decode(value, { stream: true });
							const parts = buf.split("\n\n");
							buf = parts.pop() ?? "";
							for (const part of parts) {
								if (part.startsWith(":")) continue;

								// Parse SSE id: and event: fields
								let eventType = "";
								let dataPayload = "";
								for (const line of part.split("\n")) {
									if (line.startsWith("id: ")) {
										lastSeqRef.current = Number(line.slice(4)) || 0;
									} else if (line.startsWith("event: ")) {
										eventType = line.slice(7);
									} else if (line.startsWith("data: ")) {
										dataPayload = line.slice(6);
									}
								}
								if (eventType === "reset") {
									setLines([]);
									setResetCount((c) => c + 1);
									lastSeqRef.current = 0;
									continue;
								}
								if (!dataPayload || eventType === "error" || eventType === "heartbeat") continue;
								if (active) setLines((s) => [...s, dataPayload]);
							}
							return pump();
						});
					return pump();
				})
				.catch((e) => {
					if ((e as Error).name === "AbortError" || !active) return;
					if (active) reconnectTimerRef.current = setTimeout(connect, 2000);
				});
		};

		connect();

		// Visibility / online recovery
		const onVisibility = () => {
			if (document.visibilityState === "visible" && Date.now() - lastActivityRef.current > 45_000) {
				active = true;
				connect();
			}
		};
		const onOnline = () => {
			const s = statusRef.current;
			if (s === "done" || s === "loading") {
				active = true;
				connect();
			}
		};

		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("online", onOnline);

		// Staleness check while visible
		const stalenessCheck = setInterval(() => {
			if (document.visibilityState === "visible" && Date.now() - lastActivityRef.current > 45_000) {
				active = true;
				connect();
			}
		}, 20_000);

		return () => {
			active = false;
			activeRef.current = false;
			abortRef.current?.abort();
			clearTimeout(reconnectTimerRef.current ?? undefined);
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("online", onOnline);
			clearInterval(stalenessCheck);
		};
	}, [sessionId]);

	return { lines, status, resetCount, clear };
}
