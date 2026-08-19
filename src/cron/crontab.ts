import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { CronExpressionParser } from "cron-parser";

export interface CrontabJob {
	id: string;
	cron_expr: string;
	enabled: number;
}

function validateCron(expr: string): void {
	try {
		CronExpressionParser.parse(expr);
	} catch (err) {
		throw new Error(
			`Invalid cron expression ${JSON.stringify(expr)}: ${String(err)}`,
		);
	}
}

function renderCrontabLine(
	job: CrontabJob,
	webuiPort: number,
	bindHost: string,
	cronToken: string,
): string {
	const host = bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost;
	return `${job.cron_expr} curl -sS -X POST http://${host}:${webuiPort}/internal/cron/trigger/${job.id} -H 'X-Job-Id: ${job.id}' -H 'X-Cron-Token: ${cronToken}' >> /tmp/omp-webui-cron.log 2>&1`;
}

export function writeCrontab(
	db: Database,
	crontabPath: string,
	webuiPort: number,
	bindHost: string,
	cronToken: string,
): void {
	const jobs = db
		.prepare(
			`SELECT id, cron_expr, enabled, "trigger" FROM jobs WHERE enabled = 1 ORDER BY id`,
		)
		.all() as CrontabJob[];
	const scheduled = jobs.filter((j) => j.cron_expr.trim() !== "");
	for (const job of scheduled) validateCron(job.cron_expr);

	const lines = ["# omp-webui managed — do not edit manually", ""];
	for (const job of scheduled) {
		lines.push(renderCrontabLine(job, webuiPort, bindHost, cronToken));
	}
	lines.push("");

	const dir = path.dirname(crontabPath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${crontabPath}.${Bun.randomUUIDv7()}.tmp`;
	fs.writeFileSync(tmp, lines.join("\n"));
	fs.renameSync(tmp, crontabPath);
}

export function validateCronExpr(expr: string): void {
	validateCron(expr);
}
