import type { Database } from "bun:sqlite";
import { decryptAll } from "./store";

export function buildInjectedEnv(db: Database, masterKeyPath: string, agentDir: string): Record<string, string> {
	const secrets = decryptAll(db, masterKeyPath);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) env[k] = v;
	}
	for (const [k, v] of secrets) {
		env[k] = v;
	}
	env.PI_CODING_AGENT_DIR = agentDir;
	return env;
}
