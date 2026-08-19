import type { Database } from "bun:sqlite";
import { buildInjectedEnv } from "../secrets/env";

const MAX_OUTPUT = 200_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_RUNS_PER_JOB = 50;
const RUNS_KEEP_DAYS = 30;

interface JobRow {
	id: string;
	name: string;
	cron_expr: string;
	prompt: string;
	model: string | null;
	project_id: string | null;
	cwd: string | null;
	enabled: number;
	kind: string | null;
	script_source: string | null;
	script: string | null;
	script_args: string | null;
	trigger: string | null;
	webhook_token: string | null;
}

interface ProjectRow {
	id: string;
	cwd: string;
	default_model: string | null;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function lookupPath(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const part of path.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

function stringifyValue(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

export function interpolateTemplate(tpl: string, body: unknown, headers: Record<string, string>): string {
	return tpl.replace(/\{\{\s*(payload|headers)\.([^}\s]+)\s*\}\}|\{\{\s*payload\s*\}\}/g, (whole, prefix: string | undefined, path: string | undefined) => {
		if (prefix === "headers" && path !== undefined) {
			const lower = path.toLowerCase();
			for (const [k, v] of Object.entries(headers)) {
				if (k.toLowerCase() === lower) return v;
			}
			return "";
		}
		if (prefix === "payload" && path !== undefined) {
			const v = lookupPath(body, path);
			return v === undefined ? "" : stringifyValue(v);
		}
		return body === null || body === undefined ? "" : JSON.stringify(body);
	});
}

export async function runJob(
	db: Database,
	masterKeyPath: string,
	agentDir: string,
	jobId: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	interpolate?: (prompt: string) => string,
): Promise<{ runId: string; status: string }> {
	const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
	if (!job) throw new Error(`Job ${jobId} not found`);

	let cwd = job.cwd;
	let model = job.model;
	if (job.project_id) {
		const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(job.project_id) as ProjectRow | undefined;
		if (project) {
			if (!cwd) cwd = project.cwd;
			if (!model && project.default_model) model = project.default_model;
		}
	}
	if (!cwd) cwd = process.cwd();

	const running = db
		.prepare("SELECT id FROM job_runs WHERE job_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1")
		.get(jobId) as { id: string } | undefined;
	if (running) {
		const row = db.prepare("SELECT started_at FROM job_runs WHERE id = ?").get(running.id) as { started_at: string };
		const age = Date.now() - new Date(row.started_at).getTime();
		if (age < 5 * 60_000) {
			const runId = Bun.randomUUIDv7();
			db.prepare(
				"INSERT INTO job_runs (id, job_id, started_at, finished_at, status, error) VALUES (?, ?, ?, ?, 'skipped', ?)",
			).run(runId, jobId, new Date().toISOString(), new Date().toISOString(), "previous run still active");
			return { runId, status: "skipped" };
		}
	}

	const runId = Bun.randomUUIDv7();
	const startedAt = new Date().toISOString();
	db.prepare("INSERT INTO job_runs (id, job_id, started_at, status) VALUES (?, ?, ?, 'running')").run(
		runId,
		jobId,
		startedAt,
	);

	const env = buildInjectedEnv(db, masterKeyPath, agentDir);
	let argv: string[];
	if (job.kind === "script") {
		const scriptArgs = JSON.parse(job.script_args ?? "[]") as string[];
		if (job.script_source === "file") {
			argv = ["bash", job.script ?? "", ...scriptArgs];
		} else {
			const inline = interpolate ? interpolate(job.script ?? "") : (job.script ?? "");
			argv = ["bash", "-c", inline, "--", ...scriptArgs];
		}
	} else {
		const prompt = interpolate ? interpolate(job.prompt) : job.prompt;
		const args = ["--mode", "json", "-p", prompt, "--cwd", cwd];
		if (model) args.push("--model", model);
		argv = ["omp", ...args];
	}

	let output = "";
	let exitCode: number | null = null;
	let error: string | null = null;
	let status: "success" | "error" = "success";

	try {
		const proc = Bun.spawn(argv, {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});

		const timeout = setTimeout(() => {
			try {
				proc.kill();
			} catch {}
		}, timeoutMs);

		const [stdout, stderr, exit] = await Promise.all([
			new Response(proc.stdout).text().catch(() => ""),
			new Response(proc.stderr).text().catch(() => ""),
			proc.exited,
		]);
		clearTimeout(timeout);
		exitCode = exit;
		output = truncate(stdout + (stderr ? `\n[stderr]\n${stderr}` : ""), MAX_OUTPUT);
		if (exit !== 0) {
			status = "error";
			error = `Exit ${exit}`;
		}
	} catch (err) {
		status = "error";
		error = err instanceof Error ? err.message : String(err);
		output = truncate(error, MAX_OUTPUT);
	}

	db.prepare("UPDATE job_runs SET finished_at = ?, status = ?, exit_code = ?, output = ?, error = ? WHERE id = ?").run(
		new Date().toISOString(),
		status,
		exitCode,
		output,
		error,
		runId,
	);

	return { runId, status };
}

/**
 * Prune old job_runs: keep at most MAX_RUNS_PER_JOB per job,
 * and delete any run older than RUNS_KEEP_DAYS.
 */
export function pruneOldRuns(db: Database): void {
	const cutoff = new Date(Date.now() - RUNS_KEEP_DAYS * 86_400_000).toISOString();
	// Delete runs older than retention period
	db.prepare("DELETE FROM job_runs WHERE started_at < ?").run(cutoff);
	// For each job, keep only the most recent MAX_RUNS_PER_JOB runs
	const jobs = db.prepare("SELECT DISTINCT job_id FROM job_runs").all() as { job_id: string }[];
	for (const { job_id } of jobs) {
		const stale = db
			.prepare("SELECT id FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT -1 OFFSET ?")
			.all(job_id, MAX_RUNS_PER_JOB) as { id: string }[];
		if (stale.length > 0) {
			const ids = stale.map(r => r.id);
			db.prepare(`DELETE FROM job_runs WHERE job_id = ? AND id IN (${ids.map(() => "?").join(",")})`).run(
				job_id,
				...ids,
			);
		}
	}
}
