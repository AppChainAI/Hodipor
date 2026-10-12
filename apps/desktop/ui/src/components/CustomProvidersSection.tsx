import { useRef, useState } from "react";
import type { CustomProvider } from "@siftory/protocol";
import { deleteCustomProvider, upsertCustomProvider } from "../api/client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldLabel } from "./ui/field";
import { Alert, AlertDescription } from "./ui/alert";

/** 自定义 OpenAI 兼容供应商：baseUrl + 模型列表 + key，upsert 到 providers.json / auth.json */
export function CustomProvidersSection(props: {
	providers: CustomProvider[];
	onChanged: () => Promise<void>;
}) {
	const pendingId = useRef<{ name: string; id: string } | undefined>(undefined);
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [models, setModels] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);

	const add = async () => {
		if (pendingId.current?.name !== name.trim())
			pendingId.current = {
				name: name.trim(),
				id: `custom-${crypto.randomUUID()}`,
			};
		const id = pendingId.current.id;
		const modelList = models
			.split(/[,，\s]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (!id.replace("custom-", "") || !baseUrl.trim() || modelList.length === 0)
			return;
		setError(undefined);
		setSaving(true);
		try {
			await upsertCustomProvider({
				id,
				name: name.trim(),
				baseUrl: baseUrl.trim(),
				models: modelList,
				apiKey: apiKey || undefined,
			});
			pendingId.current = undefined;
			setName("");
			setBaseUrl("");
			setModels("");
			setApiKey("");
			await props.onChanged();
		} catch (error) {
			setError(error instanceof Error ? error.message : "操作失败");
		} finally {
			setSaving(false);
		}
	};

	const remove = async (id: string) => {
		setError(undefined);
		try {
			await deleteCustomProvider(id);
			await props.onChanged();
		} catch (error) {
			setError(error instanceof Error ? error.message : "删除失败");
		}
	};

	return (
		<>
			{error && (
				<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
			)}
			<h2>自定义供应商（OpenAI 兼容）</h2>
			{props.providers.map((p) => (
				<div key={p.id} className="custom-provider">
					<div className="info">
						<strong>{p.name}</strong>
						<span>{p.baseUrl}</span>
						<span className="hint">{p.models.join("、")}</span>
					</div>
					<Button variant="destructive" onClick={() => remove(p.id)}>
						删除
					</Button>
				</div>
			))}
			<Field>
				<FieldLabel htmlFor="custom-name">名称</FieldLabel>
				<Input
					id="custom-name"
					value={name}
					placeholder="例：我的中转站"
					onChange={(e) => setName(e.target.value)}
				/>
			</Field>
			<Field>
				<FieldLabel htmlFor="custom-url">Base URL</FieldLabel>
				<Input
					id="custom-url"
					value={baseUrl}
					placeholder="https://api.example.com/v1"
					onChange={(e) => setBaseUrl(e.target.value)}
				/>
			</Field>
			<Field>
				<FieldLabel htmlFor="custom-models">模型列表（逗号或空格分隔）</FieldLabel>
				<Input
					id="custom-models"
					value={models}
					placeholder="gpt-4o-mini, deepseek-chat"
					onChange={(e) => setModels(e.target.value)}
				/>
			</Field>
			<Field>
				<FieldLabel htmlFor="custom-key">API Key</FieldLabel>
				<Input
					id="custom-key"
					type="password"
					value={apiKey}
					placeholder="sk-…"
					onChange={(e) => setApiKey(e.target.value)}
				/>
			</Field>
			<Button
				onClick={add}
				disabled={saving || !name.trim() || !baseUrl.trim() || !models.trim()}
			>
				{saving ? "添加中…" : "添加供应商"}
			</Button>
		</>
	);
}
