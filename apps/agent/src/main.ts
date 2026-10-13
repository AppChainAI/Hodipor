import { allowedOrigin, authorized, cors } from "./server/access";
import { mkdir } from "node:fs/promises";
import { DEV_AGENT_PORT } from "@siftory/protocol";
import { createAgentHost } from "./harness";
import { handleHttp } from "./server/http";
import { createWsHandler } from "./server/ws";

/** 参数：--dev（假模型 + 固定端口 + 免 token）、--port N、--data-dir PATH */
const args = process.argv.slice(2);
const dev = args.includes("--dev");
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

const dataDir = flag("--data-dir") ?? ".data";
const port = Number(flag("--port") ?? (dev ? DEV_AGENT_PORT : 0));
const token =
	process.env.SIFTORY_TOKEN ?? (dev ? undefined : crypto.randomUUID());
if (!dev && !process.env.SIFTORY_TOKEN) {
	// 独立运行时生成一次性 token 并打印；Tauri 托管时由 Rust 经 env 注入
	console.log(`siftory-agent token: ${token}`);
}

await mkdir(dataDir, { recursive: true });
const host = await createAgentHost(dataDir, { dev });

let stopping = false;
const server = Bun.serve({
	maxRequestBodySize: 256 * 1024,
	port,
	hostname: "127.0.0.1",
	async fetch(req, server) {
		if (!allowedOrigin(req, dev))
			return new Response("forbidden origin", { status: 403 });
		const respond = (response: Response) => cors(req, response);
		if (req.method === "OPTIONS")
			return respond(new Response(null, { status: 204 }));
		if (!authorized(req, token))
			return respond(new Response("unauthorized", { status: 401 }));
		const path = new URL(req.url).pathname;
		if (path === "/ws") {
			const conversationId =
				new URL(req.url).searchParams.get("conversation") ?? undefined;
			return server.upgrade(req, { data: { closed: false, conversationId } })
				? undefined
				: respond(new Response("upgrade required", { status: 426 }));
		}
		if (req.method === "POST" && path === "/api/shutdown") {
			setTimeout(() => void shutdown(), 25);
			return respond(Response.json({ ok: true }));
		}
		return respond(await handleHttp(host, req));
	},
	websocket: createWsHandler(host),
});

console.log(JSON.stringify({ type: "ready", port: server.port }));
console.log(
	`siftory-agent listening on 127.0.0.1:${server.port} (dev=${dev}, data=${dataDir})`,
);

const shutdown = async () => {
	if (stopping) return;
	stopping = true;
	server.stop(true);
	await host.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// The shell retains this pipe. EOF also closes the Agent if the shell crashes.
if (process.env.SIFTORY_PARENT_WATCH === "1") {
	process.stdin.once("end", () => void shutdown());
	process.stdin.resume();
}
