import { openrouterImagesApi } from "../api/openrouter-images.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { IMAGE_MODELS } from "../image-models.generated.js";
import { createImagesProvider, type ImagesProvider } from "../images-models.js";

export function openrouterImagesProvider(): ImagesProvider {
	return createImagesProvider({
		id: "openrouter",
		name: "OpenRouter",
		auth: { apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
		models: Object.values(IMAGE_MODELS.openrouter),
		api: openrouterImagesApi(),
	});
}
