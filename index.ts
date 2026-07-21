import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSapModelCatalogController } from "./src/model-catalog-controller.ts";
import { createSapProviders } from "./src/providers.ts";
import { registerSapModelCommands } from "./src/sap-model-commands.ts";

export default function (pi: ExtensionAPI) {
	const catalogController = createSapModelCatalogController();
	const providers = createSapProviders(catalogController);

	// coding-agent ships a nested exact pi-ai dependency, so strict resolvers can
	// see two nominally distinct Provider type identities. The runtime contract is
	// the same 0.81 object; isolate the package-boundary cast here.
	const registerNativeProvider = pi.registerProvider.bind(pi) as unknown as (
		provider: Provider,
	) => void;
	registerNativeProvider(providers.orchestration);
	registerNativeProvider(providers.foundation);
	registerSapModelCommands(pi, catalogController);
}
