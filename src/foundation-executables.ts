export type FoundationExecutable = "azure-openai" | "aws-bedrock" | "gcp-vertexai";

export function foundationExecutableForModel(modelId: string): FoundationExecutable {
	if (modelId.startsWith("anthropic--")) return "aws-bedrock";
	if (modelId.startsWith("gemini-")) return "gcp-vertexai";
	if (modelId.startsWith("gpt-")) return "azure-openai";

	throw new Error(
		`No SAP AI Core foundation executable mapping for model '${modelId}'. ` +
			"Add a mapping in foundation-executables.ts or route this model through orchestration.",
	);
}
