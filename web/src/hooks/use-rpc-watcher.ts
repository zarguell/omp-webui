import { useCallback, useEffect, useRef, useState } from "react";
import { apiPost } from "../lib/api";

export function useRpcWatcher(sessionId: string | null): {
	rpcStatus: "idle" | "connecting" | "live" | "closed";
	pendingApproval: { id: string; method: string; title?: string; options?: string[] } | null;
	respond: (r: { value: string } | { confirmed: boolean } | { cancelled: true }) => Promise<void>;
} {
	const [rpcStatus, setRpcStatus] = useState<"idle" | "connecting" | "live" | "closed">("idle");
	const [approvalQueue, setApprovalQueue] = useState<
		{ id: string; method: string; title?: string; options?: string[] }[]
	>([]);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectCountRef = useRef(0);
	const activeRef = useRef(false);

	const pendingApproval = approvalQueue[0] ?? null;

	const respond = useCallback(
		async (r: { value: string } | { confirmed: boolean } | { cancelled: true }) => {
			if (!sessionId || !pendingApproval) return;
			const approvalId = pendingApproval.id;
			setApprovalQueue((q) => q.slice(1));
			await apiPost(`/api/sessions/${sessionId}/approval`, {
				id: approvalId,
				...r,
			});
		},
		[sessionId, pendingApproval],
	);

	useEffect(() => {
		if (!sessionId) {
			setRpcStatus("idle");
			wsRef.current?.close();
			return;
		}

		activeRef.current = true;
		reconnectCountRef.current = 0;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

		const connect = () => {
			if (!activeRef.current) return;
			wsRef.current?.close();
			setRpcStatus("connecting");
			const proto = location.protocol === "https:" ? "wss:" : "ws:";
			const ws = new WebSocket(
				`${proto}//${location.host}/api/sessions/${sessionId}/ws`,
			);
			wsRef.current = ws;

			ws.onopen = () => {
				reconnectCountRef.current = 0;
				setRpcStatus("live");
			};

			ws.onclose = () => {
				setRpcStatus((s) => {
					if (s === "live" || s === "connecting") {
						if (reconnectCountRef.current < 3 && activeRef.current) {
							reconnectTimer = setTimeout(() => {
								reconnectCountRef.current++;
								connect();
							}, 1500);
						}
						return "closed";
					}
					return s;
				});
			};

			ws.onerror = () => {};

			ws.onmessage = (ev) => {
				try {
					const msg = JSON.parse(
						typeof ev.data === "string"
							? ev.data
							: new TextDecoder().decode(ev.data as ArrayBuffer),
					);
					if (msg.type === "rpc" && typeof msg.data === "string") {
						try {
							const inner = JSON.parse(msg.data);
							if (inner.type === "exit") {
								setRpcStatus("closed");
							} else if (
								inner.type === "extension_ui_request" &&
								["select", "confirm", "input"].includes(inner.method)
							) {
								setApprovalQueue((q) => [
									...q,
									{
										id: inner.id,
										method: inner.method,
										title: inner.title,
										options: inner.options,
									},
								]);
							}
						} catch {}
					}
				} catch {}
			};
		};

		connect();

		return () => {
			activeRef.current = false;
			clearTimeout(reconnectTimer ?? undefined);
			wsRef.current?.close();
		};
	}, [sessionId]);

	return { rpcStatus, pendingApproval, respond };
}
