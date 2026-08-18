import type { Database } from "bun:sqlite";

export function migrate(db: Database): void {
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA foreign_keys = ON");

	db.run(`
		CREATE TABLE IF NOT EXISTS secrets (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			encrypted_value TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			cwd TEXT NOT NULL UNIQUE,
			default_model TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			cron_expr TEXT NOT NULL,
			prompt TEXT NOT NULL,
			model TEXT,
			project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
			cwd TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS job_runs (
			id TEXT PRIMARY KEY,
			job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			status TEXT NOT NULL,
			exit_code INTEGER,
			output TEXT,
			session_file TEXT,
			error TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_job_runs_job_id ON job_runs(job_id);
		CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at);
	`);

	if (!hasColumn(db, "projects", "default_model")) {
		db.run("ALTER TABLE projects ADD COLUMN default_model TEXT");
	}
}

function hasColumn(db: Database, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
	return rows.some(r => r.name === column);
}
