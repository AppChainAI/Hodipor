import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Assemble the Pi ModelRuntime over Hodipor's own credential and model config
 * paths. Explicit paths keep the personal ~/.pi setup untouched; ModelRuntime
 * implements pi-ai Models, which is exactly what the durable Harness wants.
 */
/** @param {{ agentDir: string }} options */
export async function createHodiporModels({ agentDir }) {
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		refreshOnCreate: false,
	});
}

/**
 * Resolve "provider/model[:thinking]" against the runtime's available models.
 * @param {import("@earendil-works/pi-ai").Models} models @param {string} [spec]
 */
export function resolveModelRef(models, spec) {
	if (!spec) return undefined;
	const slash = spec.indexOf("/");
	const provider = spec.slice(0, slash);
	const rest = spec.slice(slash + 1);
	if (slash < 1 || !rest) throw new Error(`--model expects provider/model, got: ${spec}`);
	const match = rest.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
	const thinkingLevel = match?.[1];
	const modelId = match ? rest.slice(0, match.index) : rest;
	if (!thinkingLevel && !models.getModel(provider, modelId) && rest.includes(":")) {
		throw new Error(`unknown model or thinking level: ${spec}`);
	}
	const model = models.getModel(provider, modelId);
	if (!model) throw new Error(`unknown model: ${spec}`);
	return {
		model: { provider, modelId },
		...(thinkingLevel ? { thinkingLevel } : {}),
		modelName: `${provider}/${modelId}`,
	};
}

/**
 * A default model: the argument when given, else the first available chat model.
 * @param {import("@earendil-works/pi-ai").Models} models @param {string} [spec]
 */
export async function defaultModelRef(models, spec) {
	const explicit = resolveModelRef(models, spec);
	if (explicit) return explicit;
	const available = await models.getAvailable();
	const first = available[0];
	if (first) return { model: { provider: first.provider, modelId: first.id }, modelName: `${first.provider}/${first.id}` };
	return undefined;
}
