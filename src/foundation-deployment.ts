import { DeploymentApi } from "@sap-ai-sdk/ai-api";
import { resolveDeploymentId } from "@sap-ai-sdk/ai-api/internal.js";

import type { FoundationExecutable } from "./foundation-executables.ts";

export async function resolveFoundationDeploymentId(options: {
	modelId: string;
	executableId: FoundationExecutable;
	resourceGroup?: string;
}): Promise<string> {
	return resolveDeploymentId({
		scenarioId: "foundation-models",
		executableId: options.executableId,
		model: { name: options.modelId },
		resourceGroup: options.resourceGroup,
	});
}

export async function listRunningFoundationDeployments(resourceGroup?: string) {
	return DeploymentApi.deploymentQuery(
		{ scenarioId: "foundation-models", status: "RUNNING", $top: 100 },
		{ "AI-Resource-Group": resourceGroup ?? "default" },
	).execute();
}
