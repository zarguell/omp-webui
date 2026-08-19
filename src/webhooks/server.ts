import type { Database } from "bun:sqlite";
import type { WebuiConfig } from "../config";
import { interpolateTemplate, runJob } from "../cron/runner";

interface HookJobRow {
	id: string;
	trigger: string | null;
	webhook_token: string | null;
}


export type WebhookServer = Bun.Server<undefined>;
const notFound = () => new Response(JSON.stringify({ error: "not found" }), {
	status: 404,
	headers: { "content-type": "application/json" },
});

export function startWebhookServer(opts: {
	db: Database;
	config: WebuiConfig;
	masterKeyPath: string;
}): WebhookServer | null {
	const { db, config, masterKeyPath } = opts;
	if (config.webhookPort === 0) {
		console.log("webhook server disabled");
		return null;
	}
	try {
		return Bun.serve({
			port: config.webhookPort,
			hostname: config.bind,
			async fetch(req) {
				const url = new URL(req.url);
				const match = url.pathname.match(/^\/hook\/([^/]+)\/([^/]+)$/);
				if (!match || req.method !== "POST") return notFound();
				const [, jobId, token] = match;
				const job = db.prepare(`SELECT id, "trigger", webhook_token FROM jobs WHERE id = ?`).get(jobId) as
					| HookJobRow
					| undefined;
				if (!job || job.trigger !== "webhook" || job.webhook_token === null || job.webhook_token !== token) {
					return notFound();
				}
				const body = await req.json().catch(() => null);
				const headers: Record<string, string> = {};
				req.headers.forEach((v, k) => { headers[k] = v; });
				const result = runJob(db, masterKeyPath, config.agentDir, jobId, 600_000, p =>
					interpolateTemplate(p, body, headers),
				);
				result
					.then(r => console.log(`webhook job ${jobId} ${r.status} (run ${r.runId})`))
					.catch(e => console.error(`webhook job ${jobId} failed:`, e));
				return new Response(JSON.stringify({ status: "triggered", jobId }), {
					status: 202,
					headers: { "content-type": "application/json" },
				});
			},
		});
	} catch (e) {
		console.error(`webhook server failed to start: ${e}`);
		return null;
	}
}
