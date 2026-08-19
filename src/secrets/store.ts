import type { Database } from "bun:sqlite";
import { decrypt, encrypt, getMasterKey } from "../db/crypto";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SecretRow {
	id: string;
	name: string;
	encrypted_value: string;
	created_at: string;
	updated_at: string;
}

export interface SecretPublic {
	id: string;
	name: string;
	created_at: string;
	updated_at: string;
}

export function validateEnvName(name: string): void {
	if (!ENV_NAME_RE.test(name)) {
		throw new Error(
			`Invalid env var name: ${JSON.stringify(name)} — must match [A-Za-z_][A-Za-z0-9_]*`,
		);
	}
}

export function listSecrets(db: Database): SecretPublic[] {
	const rows = db
		.prepare(
			"SELECT id, name, created_at, updated_at FROM secrets ORDER BY name",
		)
		.all() as SecretPublic[];
	return rows;
}

export function createSecret(
	db: Database,
	masterKeyPath: string,
	name: string,
	value: string,
): SecretPublic {
	validateEnvName(name);
	const key = getMasterKey(masterKeyPath);
	const encrypted = encrypt(value, key);
	const id = Bun.randomUUIDv7();
	const now = new Date().toISOString();
	try {
		db.prepare(
			"INSERT INTO secrets (id, name, encrypted_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		).run(id, name, encrypted, now, now);
	} catch (err) {
		if (String(err).includes("UNIQUE constraint failed")) {
			throw new Error(
				`Secret ${JSON.stringify(name)} already exists — delete it first or use PATCH`,
			);
		}
		throw err;
	}
	return { id, name, created_at: now, updated_at: now };
}

export function updateSecret(
	db: Database,
	masterKeyPath: string,
	id: string,
	value: string,
): SecretPublic {
	const key = getMasterKey(masterKeyPath);
	const encrypted = encrypt(value, key);
	const now = new Date().toISOString();
	const result = db
		.prepare(
			"UPDATE secrets SET encrypted_value = ?, updated_at = ? WHERE id = ?",
		)
		.run(encrypted, now, id);
	if (result.changes === 0) throw new Error(`Secret ${id} not found`);
	const row = db
		.prepare(
			"SELECT id, name, created_at, updated_at FROM secrets WHERE id = ?",
		)
		.get(id) as SecretPublic;
	return row;
}

export function deleteSecret(db: Database, id: string): void {
	const result = db.prepare("DELETE FROM secrets WHERE id = ?").run(id);
	if (result.changes === 0) throw new Error(`Secret ${id} not found`);
}

export function decryptAll(
	db: Database,
	masterKeyPath: string,
): Map<string, string> {
	const rows = db
		.prepare("SELECT name, encrypted_value FROM secrets")
		.all() as SecretRow[];
	const key = getMasterKey(masterKeyPath);
	const map = new Map<string, string>();
	for (const row of rows) {
		map.set(row.name, decrypt(row.encrypted_value, key));
	}
	return map;
}

export function getSecretValue(
	db: Database,
	masterKeyPath: string,
	id: string,
): string {
	const row = db
		.prepare("SELECT encrypted_value FROM secrets WHERE id = ?")
		.get(id) as SecretRow | undefined;
	if (!row) throw new Error(`Secret ${id} not found`);
	return decrypt(row.encrypted_value, getMasterKey(masterKeyPath));
}
