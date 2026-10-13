import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Alert, AlertDescription } from "./ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export interface ModelSelectProps {
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
}

export function Composer(props: {
	busy: boolean;
	connected: boolean;
	/** 外部请求把文本填入输入框（示例选题点击）；id 变化才生效 */
	seed?: { text: string; id: number };
	/** 整体禁用并说明原因（如已有选题在跑，单并发约束） */
	disabledReason?: string;
	/** 发送按钮文案覆盖（如首页的“创建中…”） */
	sendLabel?: string;
	/** 传入时在动作行左侧渲染模型选择 */
	modelSelect?: ModelSelectProps;
	onSend: (text: string, requestId: string) => Promise<unknown>;
	onStop: () => Promise<unknown>;
}) {
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string>();
	const pending = useRef<{ text: string; id: string } | undefined>(undefined);
	const inFlight = useRef(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const seedId = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (props.seed && props.seed.id !== seedId.current) {
			seedId.current = props.seed.id;
			setText(props.seed.text);
			inputRef.current?.focus();
		}
	}, [props.seed]);
	const disabled = !!props.disabledReason;
	const send = async () => {
		const value = text.trim();
		if (!value || inFlight.current || !props.connected || disabled) return;
		if (pending.current?.text !== value)
			pending.current = { text: value, id: crypto.randomUUID() };
		inFlight.current = true;
		setSending(true);
		setError(undefined);
		try {
			await props.onSend(value, pending.current.id);
			setText((current) => (current.trim() === value ? "" : current));
			pending.current = undefined;
		} catch (error) {
			setError(error instanceof Error ? error.message : "发送失败，请重试");
		} finally {
			inFlight.current = false;
			setSending(false);
		}
	};
	const stop = async () => {
		try {
			await props.onStop();
		} catch (error) {
			setError(error instanceof Error ? error.message : "停止失败，请重试");
		}
	};
	return (
		<div className="composer-area">
			{error && (
				<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
			)}
			{props.busy && !disabled && (
				<div className="hint">新消息将排队，在当前任务完成后执行。</div>
			)}
			{disabled && <div className="hint">{props.disabledReason}</div>}
			<div className="composer">
				<Textarea
					ref={inputRef}
					className="composer-input"
					value={text}
					disabled={disabled}
					aria-label="主题或任务"
					placeholder="给 Siftory 一个主题或任务…"
					rows={2}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (
							event.key === "Enter" &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							void send();
						}
					}}
				/>
				<div className="composer-actions">
					{props.modelSelect && (
						<Select
							value={props.modelSelect.value}
							items={props.modelSelect.options}
							onValueChange={(value) => {
								if (value) props.modelSelect!.onChange(value);
							}}
						>
							<SelectTrigger className="composer-model" aria-label="模型">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{props.modelSelect.options.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					<span className="composer-spacer" />
					{props.busy && (
						<Button
							variant="destructive"
							disabled={!props.connected}
							onClick={() => void stop()}
						>
							<Square aria-hidden="true" className="size-3.5 fill-current" />
							停止
						</Button>
					)}
					<Button
						disabled={!text.trim() || sending || !props.connected || disabled}
						onClick={() => void send()}
					>
						{props.sendLabel ?? (sending ? "发送中…" : props.busy ? "排队发送" : "发送")}
						<ArrowUp aria-hidden="true" />
					</Button>
				</div>
			</div>
		</div>
	);
}
