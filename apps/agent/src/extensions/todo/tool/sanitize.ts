/**
 * 模型可控文本入库前的清洗：剥 ANSI/OSC 转义、bidi 控制符、控制字符，
 * 换行与制表折叠为空格（subject/activeForm 是单行渲染槽）。
 * 在写入（commit）时执行一次，工具输出与 UI 读到的都是干净文本。
 * 移植自 rpiv-todo 的 sanitizeTerminalText，渲染期清洗改为写入期清洗。
 */
export function sanitizeTaskText(value: string): string {
	return (
		value
			// CSI 序列（ESC-[ 与 C1 单字节引入符两种形态）
			.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
			// OSC 序列连同负载；未终止的 OSC 吞掉剩余部分，与真实终端一致
			.replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, "")
			// 剩余两字符 ESC 序列
			.replace(/\u001b./g, "")
			// Unicode 行/段分隔符与换行一样会拼行
			.replace(/[\u2028\u2029]/g, " ")
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => (ch === "\n" || ch === "\r" || ch === "\t" ? " " : ""))
			// bidi 嵌入/覆盖/隔离控制符与 LRM/RLM
			.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
	);
}
