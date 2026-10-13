import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";

export interface ArtifactServices {
	registerArtifact(
		conversationId: ConversationId,
		args: { path: string; type: string; stage: string; title?: string },
	): Promise<{ rel_path: string; title: string }>;
}

// TypeBox 参数 schema——description 同时是面向模型的提示词。
const RegisterParams = Type.Object({
	path: Type.String({
		description: "相对选题工作目录的产物文件路径，如 report.md 或 drafts/video.mp4",
	}),
	type: Type.String({
		description: "产物类型：report / script / audio / video / image / storyboard / other",
	}),
	stage: Type.String({
		description: "产生它的管道阶段：discover / synthesize / narrate / generate / produce",
	}),
	title: Type.Optional(
		Type.String({ description: "给人看的标题；缺省用文件名" }),
	),
});

/** 产物登记协议：最终交付物显式登记后进入用户的产物库；目录约定随 section 给出。 */
export function artifactsExtension(services: ArtifactServices) {
	return defineExtension({
		name: "artifacts",
		sections: [
			section("artifact-protocol", () =>
				[
					"文件与产物约定：",
					"- 你的工作目录是本次选题的专属目录，所有文件操作都在其中进行。",
					"- 原始资料放 sources/，中间帧等大体积中间文件放 frames/，临时文件放 tmp/，需要时自行创建。",
					"- 最终交付物（报告、文案、音频、视频、图片等）写好后，必须调用 register_artifact 登记；只有登记过的产物才会出现在用户的产物库中。",
				].join("\n"),
			),
		],
		tools: [
			defineTool({
				name: "register_artifact",
				description:
					"把已写好的最终交付物登记为选题产物：文件移入 artifacts/ 并进入用户的产物库。只登记交付给用户的成果，不登记中间文件。",
				parameters: RegisterParams,
				execute: async (args, api) => {
					try {
						const artifact = await services.registerArtifact(
							api.conversationId,
							args,
						);
						return {
							output: [
								{
									type: "text" as const,
									text: `已登记产物「${artifact.title}」→ ${artifact.rel_path}`,
								},
							],
						};
					} catch (error) {
						return {
							output: [
								{
									type: "text" as const,
									text: `登记失败：${error instanceof Error ? error.message : String(error)}`,
								},
							],
							isError: true,
						};
					}
				},
			}),
		],
	});
}
