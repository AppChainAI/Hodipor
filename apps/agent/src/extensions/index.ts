import type { Registry } from "@earendil-works/pi-durable";
import core from "./core";
import todo from "./todo";
import { CodingTools } from "@earendil-works/pi-durable/tools";

/** 内建扩展清单。顺序有意义：同名工具后者覆盖前者，wraps 依赖安装顺序。 */
export const builtins = [core, todo, CodingTools];

export function installAll(registry: Registry): void {
	for (const extension of builtins) registry.install(extension);
}
