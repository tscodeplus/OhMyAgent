import { openAICompletionsApi } from "../api/openai-completions.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider, type Provider } from "../models.js";
import { OPENROUTER_MODELS } from "./openrouter.models.js";

export function openrouterProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "openrouter",
		name: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		auth: { apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
		models: Object.values(OPENROUTER_MODELS),
		api: openAICompletionsApi(),
	});
}
