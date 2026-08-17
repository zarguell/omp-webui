import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { migrate } from "./migrate";

let db: Database | null = null;
let dbPath: string | null = null;

export function getDb(dbFilePath: string): Database {
	if (db && dbPath === dbFilePath) return db;
	if (db) {
		db.close();
		db = null;
	}
	fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
	db = new Database(dbFilePath);
	migrate(db);
	dbPath = dbFilePath;
	return db;
}

export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
		dbPath = null;
	}
}
