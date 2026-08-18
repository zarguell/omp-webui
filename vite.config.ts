import * as path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	root: path.resolve(import.meta.dirname, "web"),
	build: {
		outDir: "../dist/web",
		emptyOutDir: true,
	},
	server: {
		proxy: {
			"/api": "http://127.0.0.1:8787",
			"/internal": "http://127.0.0.1:8787",
		},
	},
});
