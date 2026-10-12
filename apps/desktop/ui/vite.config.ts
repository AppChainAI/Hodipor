import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
	server: {
		port: 5173,
		strictPort: true,
		// 只代理 HTTP；WS 由浏览器直连 sidecar（见 client.ts）
		proxy: {
			"/api": "http://127.0.0.1:47911",
		},
	},
});
