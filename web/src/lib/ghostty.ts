export async function loadGhostty(): Promise<unknown> {
	try {
		const wasmUrl = new URL("ghostty-web/ghostty-vt.wasm", import.meta.url).toString();
		const res = await fetch(wasmUrl);
		if (!res.ok) return null;
		const bytes = await res.arrayBuffer();
		const mod = await WebAssembly.compile(bytes);
		const { Ghostty } = await import("ghostty-web");
		return new Ghostty(new WebAssembly.Instance(mod, { env: { log: () => {} } }));
	} catch { return null; }
}
