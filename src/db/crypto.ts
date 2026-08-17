import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function loadMasterKey(masterKeyPath: string): Buffer {
	const envKey = process.env.OMP_WEBUI_MASTER_KEY;
	if (envKey) {
		const trimmed = envKey.trim();
		if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
		try {
			const decoded = Buffer.from(trimmed, "base64");
			if (decoded.length === 32) return decoded;
			const urlDecoded = Buffer.from(trimmed, "base64url");
			if (urlDecoded.length === 32) return urlDecoded;
		} catch {}
		throw new Error("OMP_WEBUI_MASTER_KEY must be 32 bytes as hex (64 chars) or base64");
	}
	if (!fs.existsSync(masterKeyPath)) {
		fs.mkdirSync(path.dirname(masterKeyPath), { recursive: true });
		const key = crypto.randomBytes(32);
		fs.writeFileSync(masterKeyPath, key.toString("base64"), { mode: 0o600 });
		try {
			fs.chmodSync(masterKeyPath, 0o600);
		} catch {}
		return key;
	}
	const raw = fs.readFileSync(masterKeyPath, "utf8").trim();
	if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
	try {
		const decoded = Buffer.from(raw, "base64");
		if (decoded.length === 32) return decoded;
	} catch {}
	try {
		const decoded = Buffer.from(raw, "base64url");
		if (decoded.length === 32) return decoded;
	} catch {}
	throw new Error(`Master key at ${masterKeyPath} is not 32 bytes (hex 64 or base64)`);
}

let cachedKey: Buffer | null = null;
let cachedPath: string | null = null;

export function getMasterKey(masterKeyPath: string): Buffer {
	if (cachedKey && cachedPath === masterKeyPath && !process.env.OMP_WEBUI_MASTER_KEY) return cachedKey;
	const key = loadMasterKey(masterKeyPath);
	if (!process.env.OMP_WEBUI_MASTER_KEY) {
		cachedKey = key;
		cachedPath = masterKeyPath;
	}
	return key;
}

export function encrypt(plaintext: string, masterKey: Buffer): string {
	const iv = crypto.randomBytes(IV_LEN);
	const cipher = crypto.createCipheriv(ALGO, masterKey, iv);
	const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(blob: string, masterKey: Buffer): string {
	const buf = Buffer.from(blob, "base64");
	if (buf.length < IV_LEN + TAG_LEN) throw new Error("Invalid encrypted blob");
	const iv = buf.subarray(0, IV_LEN);
	const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
	const enc = buf.subarray(IV_LEN + TAG_LEN);
	const decipher = crypto.createDecipheriv(ALGO, masterKey, iv);
	decipher.setAuthTag(tag);
	return decipher.update(enc) + decipher.final("utf8");
}
