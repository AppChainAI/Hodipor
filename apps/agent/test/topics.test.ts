import { expect, it } from "bun:test";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createAgentHost } from "../src/harness";

const context = BACKGROUND_CONTEXT;
const temporary = () => mkdtemp(join(tmpdir(), "siftory-topics-"));

it("creates a topic with its own directory and cwd, inheriting root's model", async () => {
	const directory = await temporary();
	const host = await createAgentHost(directory, { dev: true });
	try {
		const topic = await host.createTopic("研究固态电池的最新进展，做成一期科普视频");
		expect(topic.title).toBe("研究固态电池的最新进展，做成一期科普视频");
		expect(topic.dir).toBe(`topics/${topic.id}`);
		// cwd 绑定选题目录；模型配置从 root 复制（dev 兜底 faux）
		const conversation = await host.conversation(topic.id);
		const agent = await conversation!.agent(context);
		expect(agent.cwd).toBe(host.topicDir(topic));
		expect(agent.model).toEqual({ provider: "faux", modelId: "faux-1" });
		// root 自身不是选题
		expect(host.getTopic(String(host.root.id))).toBeUndefined();
	} finally {
		await host.close();
	}
});

it("registers artifacts into artifacts/ with guards and an index row", async () => {
	const directory = await temporary();
	const host = await createAgentHost(directory, { dev: true });
	try {
		const topic = await host.createTopic("写一份行业研究报告");
		const dir = host.topicDir(topic);
		await writeFile(join(dir, "report.md"), "# 行业研究\n\n正文第一段。".repeat(10));
		const conversation = await host.conversation(topic.id);

		const artifact = await host.registerArtifact(
			conversation!.id,
			{ path: "report.md", type: "report", stage: "synthesize", title: "行业研究报告" },
		);
		expect(artifact.rel_path).toBe("artifacts/report.md");
		expect(artifact.excerpt).toContain("行业研究");
		// 文件已移入 artifacts/，索引可查
		const moved = await readFile(join(dir, "artifacts", "report.md"), "utf8");
		expect(moved).toContain("行业研究");
		expect(host.listArtifacts(topic.id).map((a) => a.title)).toEqual(["行业研究报告"]);

		// 同名再登记不覆盖：自动改名
		await writeFile(join(dir, "report.md"), "v2");
		const second = await host.registerArtifact(conversation!.id, {
			path: "report.md", type: "report", stage: "synthesize",
		});
		expect(second.rel_path).toBe("artifacts/report-2.md");

		// 模型直接把文件写进 artifacts/：原样登记，不改名不挪动
		await writeFile(join(dir, "artifacts", "direct.md"), "直接写进产物目录");
		const direct = await host.registerArtifact(conversation!.id, {
			path: "artifacts/direct.md", type: "report", stage: "synthesize",
		});
		expect(direct.rel_path).toBe("artifacts/direct.md");
		expect(await readFile(join(dir, "artifacts", "direct.md"), "utf8")).toContain("直接写进产物目录");

		// 路径越界与文件不存在都被拒
		await mkdir(join(dir, "sub"), { recursive: true });
		await expect(
			host.registerArtifact(conversation!.id, { path: "../outside.txt", type: "report", stage: "synthesize" }),
		).rejects.toThrow("选题目录内");
		await expect(
			host.registerArtifact(conversation!.id, { path: "missing.md", type: "report", stage: "synthesize" }),
		).rejects.toThrow("文件不存在");
		// 非选题会话（root）拒绝登记
		await expect(
			host.registerArtifact(String(host.root.id) as unknown as ConversationId, {
				path: "report.md", type: "report", stage: "synthesize",
			}),
		).rejects.toThrow("不是选题");

		// 重启后索引仍在
		await host.close();
		const reopened = await createAgentHost(directory, { dev: true });
		try {
			expect(reopened.listTopics().map((t) => t.id)).toContain(topic.id);
			expect(reopened.listArtifacts(topic.id).length).toBe(3);
		} finally {
			await reopened.close();
		}
	} catch (error) {
		await host.close().catch(() => {});
		throw error;
	}
});

// 回归：dev 默认的相对 dataDir（.data）曾让 registerArtifact 的 startsWith 守卫
// 把合法路径全部误判越界（绝对 src 对相对 base）。workspace 必须在边界归一为绝对路径。
it("registers artifacts with a relative data dir", async () => {
	const parent = await mkdtemp(join(tmpdir(), "siftory-rel-"));
	const previousCwd = process.cwd();
	process.chdir(parent);
	const host = await createAgentHost(".data", { dev: true });
	try {
		const topic = await host.createTopic("相对数据目录登记测试");
		expect(host.topicDir(topic).startsWith("/")).toBe(true);
		await writeFile(join(host.topicDir(topic), "note.md"), "相对路径下的产物");
		const artifact = await host.registerArtifact(
			(await host.conversation(topic.id))!.id,
			{ path: "note.md", type: "report", stage: "synthesize" },
		);
		expect(artifact.rel_path).toBe("artifacts/note.md");
		expect(artifact.excerpt).toContain("相对路径下的产物");
	} finally {
		await host.close();
		process.chdir(previousCwd);
	}
});
