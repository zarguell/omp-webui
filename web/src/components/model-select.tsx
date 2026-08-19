import type React from "react";
import { useEffect, useState } from "react";
import { apiGet } from "../lib/api";

export interface ModelOption {
	selector: string;
	name: string;
	provider: string;
}

/** Model picker following the session-chat discovery pattern: /api/models → provider/name labels. */
export function ModelSelect({
	value,
	onChange,
	allowNone = false,
	style,
	ariaLabel = "Model",
}: {
	value: string;
	onChange: (selector: string) => void;
	allowNone?: boolean;
	style?: React.CSSProperties;
	ariaLabel?: string;
}): React.ReactElement {
	const [models, setModels] = useState<ModelOption[]>([]);

	useEffect(() => {
		let active = true;
		void apiGet("/api/models")
			.then((data: unknown) => {
				const d = data as { models?: ModelOption[] };
				if (active && d.models) setModels(d.models);
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, []);

	const label = (m: ModelOption) => `${m.provider}/${m.name}`;
	const current = value
		? label(
				models.find((m) => m.selector === value) ?? {
					selector: value,
					name: value.split("/").pop() ?? value,
					provider: value.split("/")[0] ?? "",
				},
			)
		: null;

	return (
		<select
			aria-label={ariaLabel}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			style={style}
			title={value}
		>
			{allowNone && <option value="">— none —</option>}
			{current && <option value={value}>{current}</option>}
			{models
				.filter((m) => m.selector !== value)
				.map((m) => (
					<option key={m.selector} value={m.selector}>
						{label(m)}
					</option>
				))}
		</select>
	);
}
