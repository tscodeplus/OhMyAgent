/**
 * Temporary compatibility entrypoint preserving the old global pi-ai API
 * surface: api-dispatch `stream()`/`complete()` with env API key injection,
 * the api-registry, generated catalog reads (`getModel`/`getModels`/
 * `getProviders`), per-API lazy stream wrappers, and image generation.
 *
 * Existing apps switch imports from "@earendil-works/pi-ai" to
 * "@earendil-works/pi-ai/compat" unchanged; new code uses `createModels()`
 * and the provider factories. This module is deleted with the coding-agent
 * ModelManager migration.
 */

export * from "./api/anthropic-messages.lazy.js";
export * from "./api/azure-openai-responses.lazy.js";
export * from "./api/bedrock-converse-stream.lazy.js";
export * from "./api/google-generative-ai.lazy.js";
export * from "./api/google-vertex.lazy.js";
export * from "./api/mistral-conversations.lazy.js";
export * from "./api/openai-codex-responses.lazy.js";
export * from "./api/openai-completions.lazy.js";
export * from "./api/openai-responses.lazy.js";
export * from "./env-api-keys.js";
export * from "./image-models.js";
export * from "./images.js";
export * from "./images-api-registry.js";
export * from "./index.js";
export * from "./legacy-api-aliases.js";
export * from "./providers/images/register-builtins.js";

import { anthropicMessagesApi } from "./api/anthropic-messages.lazy.js";
import { azureOpenAIResponsesApi } from "./api/azure-openai-responses.lazy.js";
import { bedrockConverseStreamApi } from "./api/bedrock-converse-stream.lazy.js";
import { googleGenerativeAIApi } from "./api/google-generative-ai.lazy.js";
import { googleVertexApi } from "./api/google-vertex.lazy.js";
import { mistralConversationsApi } from "./api/mistral-conversations.lazy.js";
import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.js";
import { openAICompletionsApi } from "./api/openai-completions.lazy.js";
import { openAIResponsesApi } from "./api/openai-responses.lazy.js";
import { getEnvApiKey } from "./env-api-keys.js";
import { builtinModels, getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "./providers/all.js";
import { createFauxCore, type FauxProviderRegistration, type RegisterFauxProviderOptions } from "./providers/faux.js";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	ProviderStreams,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.js";

/** @deprecated Static catalog read. Use `getBuiltinModel` from "@earendil-works/pi-ai/providers/all" or `Models.getModel()`. */
export function getModel<TProvider extends string, TModelId extends string>(
	provider: TProvider,
	modelId: TModelId,
): Model<Api> | undefined {
	// Check custom registry first (OhMyAgent: runtime-registered models)
	const customModels = customModelRegistry.get(provider);
	const custom = customModels?.get(modelId);
	if (custom) return custom;

	// Dynamic model fallback: provider is known but model ID isn't in builtin catalog.
	// Clone the first registered model of this provider to inherit headers/baseUrl/compat,
	// then substitute the caller's model ID. API gateways (NVIDIA NIM, OpenRouter, etc.)
	// proxy arbitrary model IDs through their OpenAI-compatible endpoint.
	const builtin = getBuiltinModel(provider as any, modelId as any);
	if (builtin) return builtin;

	// Dynamic model fallback for custom-registered providers (API gateways like NVIDIA NIM)
	if (customModels && customModels.size > 0) {
		const template = customModels.values().next().value;
		if (template) {
			const dynamic = { ...template, id: modelId, name: modelId } as Model<Api>;
			customModels.set(modelId, dynamic);
			return dynamic;
		}
	}

	// Also try dynamic resolution from builtin models for this provider
	const builtinModels = getBuiltinModels(provider as any);
	if (builtinModels && builtinModels.length > 0) {
		const template = builtinModels[0] as Model<Api>;
		if (template) {
			const dynamic = { ...template, id: modelId, name: modelId } as Model<Api>;
			// Cache the dynamic model in the custom registry
			let pm = customModelRegistry.get(provider);
			if (!pm) { pm = new Map(); customModelRegistry.set(provider, pm); }
			pm.set(modelId, dynamic);
			return dynamic;
		}
	}

	return undefined;
}

/** @deprecated Static catalog read. Use `getBuiltinModels` from "@earendil-works/pi-ai/providers/all" or `Models.getModels()`. */
export const getModels = getBuiltinModels;

/** @deprecated Static catalog read. Use `getBuiltinProviders` from "@earendil-works/pi-ai/providers/all" or `Models.getProviders()`. */
export const getProviders = getBuiltinProviders;

export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}

type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string;
};

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return streamSimple(model as Model<TApi>, context, options);
	};
}

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	apiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
		},
		sourceId,
	});
}

export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.provider;
}

export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

export function unregisterApiProviders(sourceId: string): void {
	for (const [api, entry] of apiProviderRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			apiProviderRegistry.delete(api);
		}
	}
}

function clearApiProviders(): void {
	apiProviderRegistry.clear();
}

export function registerFauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderRegistration {
	const core = createFauxCore(options);
	const sourceId = `faux-provider-${Math.random().toString(36).slice(2, 10)}`;
	registerApiProvider({ api: core.api, stream: core.stream, streamSimple: core.streamSimple }, sourceId);
	return {
		api: core.api,
		models: core.models,
		getModel: core.getModel,
		state: core.state,
		setResponses: core.setResponses,
		appendResponses: core.appendResponses,
		getPendingResponseCount: core.getPendingResponseCount,
		unregister() {
			unregisterApiProviders(sourceId);
		},
	};
}

const BUILTIN_APIS: [Api, ProviderStreams][] = [
	["anthropic-messages", anthropicMessagesApi()],
	["openai-completions", openAICompletionsApi()],
	["openai-responses", openAIResponsesApi()],
	["openai-codex-responses", openAICodexResponsesApi()],
	["azure-openai-responses", azureOpenAIResponsesApi()],
	["google-generative-ai", googleGenerativeAIApi()],
	["google-vertex", googleVertexApi()],
	["mistral-conversations", mistralConversationsApi()],
	["bedrock-converse-stream", bedrockConverseStreamApi()],
];

const builtinApiProviderInstances = new Map<Api, ReturnType<typeof getApiProvider>>();

/**
 * Registers the builtin API implementations into the api-registry without
 * clobbering existing entries: compat may load after a test or extension has
 * already registered an override for a builtin api id.
 */
export function registerBuiltInApiProviders(): void {
	for (const [api, streams] of BUILTIN_APIS) {
		if (!getApiProvider(api)) {
			registerApiProvider({ api, stream: streams.stream, streamSimple: streams.streamSimple });
		}
		builtinApiProviderInstances.set(api, getApiProvider(api));
	}
}

export function resetApiProviders(): void {
	clearApiProviders();
	builtinApiProviderInstances.clear();
	registerBuiltInApiProviders();
}

registerBuiltInApiProviders();

const compatModels = builtinModels();

function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function withEnvApiKey<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	if (hasExplicitApiKey(options?.apiKey)) return options;
	const apiKey = getEnvApiKey(model.provider, options?.env);
	if (!apiKey) return options;
	return { ...options, apiKey } as TOptions;
}

function shouldUseBuiltinModels(model: Model<Api>): boolean {
	const builtin = compatModels.getModel(model.provider, model.id);
	return builtin?.api === model.api && getApiProvider(model.api) === builtinApiProviderInstances.get(model.api);
}

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	if (shouldUseBuiltinModels(model)) {
		return compatModels.stream(model, context, options as ApiStreamOptions<TApi> | undefined);
	}
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, withEnvApiKey(model, options) as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	if (shouldUseBuiltinModels(model)) {
		return compatModels.streamSimple(model, context, options);
	}
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, withEnvApiKey(model, options));
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}

// ---------------------------------------------------------------------------
// OhMyAgent custom extensions: model registration and comparison
// (calculateCost, getSupportedThinkingLevels, clampThinkingLevel are
// re-exported from models.ts via index.ts — do not duplicate here)
// ---------------------------------------------------------------------------

// Custom model registry for runtime-registered models (e.g., MiMo via faux provider)
const customModelRegistry = new Map<string, Map<string, Model<Api>>>();

/**
 * Register a model at runtime. Models registered this way take precedence over
 * builtin catalog entries in `getModel`.
 */
export function registerModel<TApi extends Api>(
	provider: string,
	modelId: string,
	model: Model<TApi>,
): void {
	let providerModels = customModelRegistry.get(provider);
	if (!providerModels) {
		providerModels = new Map<string, Model<Api>>();
		customModelRegistry.set(provider, providerModels);
	}
	providerModels.set(modelId, model as Model<Api>);
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function isSameModel(a?: Model<Api> | null, b?: Model<Api> | null): boolean {
	if (!a || !b) return false;
	return a.provider === b.provider && a.id === b.id;
}
