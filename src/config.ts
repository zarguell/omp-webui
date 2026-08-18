import * as path from "node:path";

export interface WebuiConfig {
	dataDir: string;
	agentDir: string;
	dbPath: string;
	crontabPath: string;
	masterKeyPath: string;
	port: number;
	bind: string;
}

function localDataDir(): string {
	if (process.env.OMP_WEBUI_DATA_DIR || process.env.DATA_DIR)
		return process.env.OMP_WEBUI_DATA_DIR ?? process.env.DATA_DIR ?? "/data";
	try {
		Bun.file("/data/.probe").size;
	} catch (e) {
		const code = (e as { code?: string }).code;
		if (code === "EROFS" || String(e).includes("EROFS")) return path.join(process.env.HOME ?? "/tmp", ".omp-webui");
	}
	try {
		const fs = require("node:fs");
		fs.mkdirSync("/data", { recursive: true });
		return "/data";
	} catch (e) {
		const code = (e as { code?: string }).code;
		if (code === "EROFS" || code === "EACCES" || code === "EPERM")
			return path.join(process.env.HOME ?? "/tmp", ".omp-webui");
	}
	return "/data";
}

export function getConfig(): WebuiConfig {
	const dataDir = localDataDir();
	const port = Number.parseInt(process.env.OMP_WEBUI_PORT ?? process.env.PORT ?? "8787", 10);
	const bind = process.env.OMP_WEBUI_BIND ?? "127.0.0.1";
	return {
		dataDir,
		agentDir: process.env.PI_CODING_AGENT_DIR ?? path.join(dataDir, "agent"),
		dbPath: process.env.OMP_WEBUI_DB_PATH ?? path.join(dataDir, "omp-webui.db"),
		crontabPath: process.env.CRONTAB_PATH ?? path.join(dataDir, "crontab"),
		masterKeyPath: process.env.MASTER_KEY_PATH ?? path.join(dataDir, "keys", "master.key"),
		port: Number.isNaN(port) ? 8787 : port,
		bind,
	};
}
