export async function apiGet(path: string): Promise<unknown> {
	const res = await fetch(path);
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	return res.json();
}

export async function apiPost(path: string, body: unknown): Promise<unknown> {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	return res.json();
}

export async function apiPatch(path: string, body: unknown): Promise<unknown> {
	const res = await fetch(path, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	return res.json();
}

export async function apiPut(path: string, body: unknown): Promise<unknown> {
	const res = await fetch(path, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	return res.json();
}

export async function apiDelete(path: string): Promise<unknown> {
	const res = await fetch(path, { method: "DELETE" });
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	return res.json();
}
