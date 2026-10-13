import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const object = { additionalProperties: false };
const text = Type.String({ minLength: 1, maxLength: 1000 });
export const ModelSchema = Type.Object(
	{ provider: text, modelId: text },
	object,
);
export const ChatSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, maxLength: 100_000 }),
		requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		/** 目标会话（选题）id；缺省为 root 会话 */
		conversationId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
	},
	object,
);
export const CustomProviderSchema = Type.Object(
	{
		id: Type.String({
			pattern: "^custom-[a-z0-9]+(?:-[a-z0-9]+)*$",
			maxLength: 100,
		}),
		name: text,
		baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
		models: Type.Array(text, { minItems: 1, maxItems: 200, uniqueItems: true }),
	},
	object,
);
export const CustomProviderUpsertSchema = Type.Object(
	{
		...CustomProviderSchema.properties,
		apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 10_000 })),
	},
	object,
);
export const ConfigSchema = Type.Object(
	{
		/** agent 配置写入的目标会话 id；缺省为 root 会话（新选题的默认值模板） */
		conversationId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		provider: Type.Optional(
			Type.Object(
				{ id: text, apiKey: Type.String({ minLength: 1, maxLength: 10_000 }) },
				object,
			),
		),
		agent: Type.Optional(
			Type.Object(
				{
					model: Type.Optional(ModelSchema),
					thinkingLevel: Type.Optional(
						Type.Union(
							["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
								(value) => Type.Literal(value),
							),
						),
					),
					instructions: Type.Optional(Type.String({ maxLength: 100_000 })),
				},
				object,
			),
		),
	},
	object,
);
export function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
	if (!Value.Check(schema, value)) throw new Error("Invalid request fields");
	return value as Static<T>;
}
export function validateProviderUrl(value: string): void {
	const url = new URL(value);
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error(
			"Provider URL must be HTTP(S), without credentials, query or fragment",
		);
}
