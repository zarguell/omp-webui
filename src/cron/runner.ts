import type { Database } from "bun:sqlite";
import { buildInjectedEnv } from "../secrets/env";

const MAX_OUTPUT = 200_000;
const DEFAULT_TIMEOUT_MS = 600_000;

interface JobRow {
	id: string;
	name: string;
	cron_expr: string;
	prompt: string;
	model: string | null;
	project_id: string | null;
	cwd: string | null;
	enabled: number;
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

export async function runJob(
	db: Database,
	masterKeyPath: string,
	agentDir: string,
	jobId: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
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
	const args = ["--mode", "json", "-p", job.prompt, "--cwd", cwd];
	if (model) args.push("--model", model);

	let output = "";
	let exitCode: number | null = null;
	let error: string | null = null;
	let status: "success" | "error" = "success";

	try {
		const proc = Bun.spawn(["omp", ...args], {
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
