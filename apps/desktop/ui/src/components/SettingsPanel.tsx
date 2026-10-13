import { useEffect, useState } from "react";
import type { ConfigView, ThinkingLevel } from "@siftory/protocol";
import { getConfig, putConfig } from "../api/client";
import { CustomProvidersSection } from "./CustomProvidersSection";
import { Button } from "./ui/button";
import { Field, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { Alert, AlertDescription } from "./ui/alert";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { useTheme } from "./ThemeProvider";
import { parseTheme } from "../theme";

const THINKING_LEVELS: { value: ThinkingLevel; label: string }[] = [
	{ value: "off", label: "关闭思考" },
	{ value: "minimal", label: "minimal" },
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high" },
	{ value: "xhigh", label: "xhigh" },
	{ value: "max", label: "max" },
];

/** 提供商 + 会话级 LLM 配置对话框。model/thinkingLevel/instructions 存会话的 pi.agent（SQLite），key 存 auth.json */
export function SettingsPanel(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { preference, setPreference } = useTheme();
	const [config, setConfig] = useState<ConfigView>();
	const [provider, setProvider] = useState("openai");
	const [apiKey, setApiKey] = useState("");
	const [modelId, setModelId] = useState("");
	const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
	const [instructions, setInstructions] = useState("");
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);

	const reload = async () => {
		const next = await getConfig();
		setConfig(next);
		setThinkingLevel(next.agent.thinkingLevel);
		setInstructions(next.agent.instructions ?? "");
		if (next.agent.model) {
			setProvider(next.agent.model.provider);
			setModelId(next.agent.model.modelId);
		}
	};
	useEffect(() => {
		void reload().catch((error) => setError(String(error)));
	}, []);

	const models = config?.models[provider] ?? [];
	const current = config?.providers.find((p) => p.id === provider);

	const save = async () => {
		setSaving(true);
		setError(undefined);
		try {
			await putConfig({
				...(apiKey ? { provider: { id: provider, apiKey } } : {}),
				agent: {
					...(modelId ? { model: { provider, modelId } } : {}),
					thinkingLevel,
					instructions,
				},
			});
			setApiKey("");
			await reload();
		} catch (error) {
			setError(error instanceof Error ? error.message : "保存失败，请重试");
		} finally {
			setSaving(false);
		}
	};

	const themes = [
		{ value: "system", label: "跟随系统" },
		{ value: "light", label: "浅色" },
		{ value: "dark", label: "深色" },
	];
	const providers = config?.providers.map((p) => ({
		value: p.id,
		label: `${p.id}${p.configured ? " ✓" : ""}`,
	})) ?? [];
	const modelOptions = [
		{ value: "", label: "选择模型…" },
		...models.map((id) => ({ value: id, label: id })),
	];

	const appearance = (
		<>
			<h2>外观</h2>
			<Field>
				<FieldLabel htmlFor="theme">主题</FieldLabel>
				<Select id="theme" value={preference} items={themes} onValueChange={(value) => setPreference(parseTheme(value))}>
					<SelectTrigger className="w-full max-w-60"><SelectValue /></SelectTrigger>
					<SelectContent>
						{themes.map((theme) => <SelectItem key={theme.value} value={theme.value}>{theme.label}</SelectItem>)}
					</SelectContent>
				</Select>
			</Field>
		</>
	);

	const body = !config ? (
		<>
			{appearance}
			{error ?? "加载中…"}
			<Button
				onClick={() =>
					void reload().catch((error) => setError(String(error)))
				}
			>
				重新加载
			</Button>
		</>
	) : (
		<>
			{error && (
				<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
			)}
			{appearance}
			<h2>模型提供商</h2>
			<Field>
				<FieldLabel htmlFor="provider">提供商</FieldLabel>
				<Select
					id="provider"
					value={provider}
					items={providers}
					onValueChange={(value) => {
						if (value === null) return;
						setProvider(value);
						setModelId("");
						setApiKey("");
					}}
				>
					<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
					<SelectContent>
						{providers.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
					</SelectContent>
				</Select>
			</Field>
			<Field>
				<FieldLabel htmlFor="provider-key">API Key{current?.configured ? "（已配置，输入即替换）" : ""}</FieldLabel>
				<Input
					id="provider-key"
					type="password"
					value={apiKey}
					placeholder={current?.configured ? "••••••" : "sk-…"}
					onChange={(e) => setApiKey(e.target.value)}
				/>
			</Field>

			<h2>会话配置</h2>
			<Field>
				<FieldLabel htmlFor="model">模型</FieldLabel>
				<Select id="model" value={modelId} items={modelOptions} onValueChange={(value) => setModelId(value ?? "")}>
					<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
					<SelectContent>
						{modelOptions.map((model) => <SelectItem key={model.value} value={model.value}>{model.label}</SelectItem>)}
					</SelectContent>
				</Select>
			</Field>
			<Field>
				<FieldLabel htmlFor="thinking-level">思考级别</FieldLabel>
				<Select<ThinkingLevel> id="thinking-level" value={thinkingLevel} items={THINKING_LEVELS} onValueChange={(value) => { if (value !== null) setThinkingLevel(value); }}>
					<SelectTrigger className="w-full max-w-60"><SelectValue /></SelectTrigger>
					<SelectContent>
						{THINKING_LEVELS.map((level) => <SelectItem key={level.value} value={level.value}>{level.label}</SelectItem>)}
					</SelectContent>
				</Select>
			</Field>
			<Field>
				<FieldLabel htmlFor="instructions">附加指令（追加到系统提示词末尾）</FieldLabel>
				<Textarea
					id="instructions"
					rows={4}
					value={instructions}
					placeholder="例：总是用中文回答；回答保持简短"
					onChange={(e) => setInstructions(e.target.value)}
				/>
			</Field>
			<Button onClick={save} disabled={saving}>
				{saving ? "保存中…" : "保存"}
			</Button>

			<CustomProvidersSection
				providers={config.customProviders}
				onChanged={reload}
			/>
		</>
	);

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="settings-dialog sm:max-w-2xl" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>设置</DialogTitle>
				</DialogHeader>
				<div className="settings">{body}</div>
			</DialogContent>
		</Dialog>
	);
}
