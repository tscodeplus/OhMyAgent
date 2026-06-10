/**
 * Vision Bridge end-to-end test script.
 *
 * Tests: DeepSeek-V4 (text-only) + image → Vision Bridge →
 * kimi-k2.6 analyzes image → text context injected → DeepSeek-V4 receives text only.
 *
 * Run: npx tsx tests/manual/vision-bridge-test.ts
 */

// Load .env before anything else
import 'dotenv/config';

import { loadConfig } from '../../src/app/config.js';
import { loadVisionBridgeConfig } from '../../src/vision-bridge/vision-bridge-config.js';
import { VisionBridgeService } from '../../src/vision-bridge/vision-bridge-service.js';
import { getModel, registerModel } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai';

// Create a tiny test PNG (1x1 red pixel) as base64
const TEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

async function main() {
  console.log('=== Vision Bridge E2E Test ===\n');

  // 1. Load configs
  const appConfig = loadConfig(process.env);
  const bridgeConfig = loadVisionBridgeConfig(process.env);

  console.log('Config:');
  console.log(`  Main model: ${appConfig.piAi.provider}/${appConfig.piAi.model}`);
  console.log(`  Vision Bridge: ${bridgeConfig.enabled}`);
  console.log(`  Vision model ref: ${bridgeConfig.modelRef}`);
  console.log(`  Custom providers: ${appConfig.customProviders?.map(p => p.provider).join(', ') ?? 'none'}`);
  console.log();

  if (!bridgeConfig.enabled) {
    console.log('ERROR: Vision Bridge is not enabled. Set VISION_BRIDGE_ENABLED=true in .env');
    process.exit(1);
  }

  // 2. Register custom provider models (like bootstrap.ts does)
  if (appConfig.customProviders) {
    for (const cp of appConfig.customProviders) {
      for (const m of cp.models) {
        try {
          registerModel(cp.provider, m.id, {
            id: m.id,
            name: m.name,
            api: m.api,
            apiKey: cp.apiKey,
            provider: cp.provider,
            baseUrl: cp.baseUrl,
            reasoning: m.reasoning ?? false,
            input: m.input ?? ['text'],
            cost: {
              input: m.cost?.input ?? 0,
              output: m.cost?.output ?? 0,
              cacheRead: m.cost?.cacheRead ?? 0,
              cacheWrite: m.cost?.cacheWrite ?? 0,
            },
            contextWindow: m.contextWindow ?? 128000,
            maxTokens: m.maxTokens ?? 16000,
          } as any);
          console.log(`  Registered: ${cp.provider}/${m.id} input=${JSON.stringify(m.input ?? ['text'])}`);
        } catch (err: any) {
          console.warn(`  Skip ${cp.provider}/${m.id}: ${err.message}`);
        }
      }
    }
    console.log();
  }

  // 3. Create VisionBridgeService
  const bridge = new VisionBridgeService(bridgeConfig, appConfig.customProviders ?? []);

  // 4. Get the target (text-only) model
  const targetModel = getModel(appConfig.piAi.provider as any, appConfig.piAi.model as any);
  if (!targetModel) {
    console.log(`ERROR: Target model ${appConfig.piAi.provider}/${appConfig.piAi.model} not found`);
    process.exit(1);
  }

  console.log('Target model:');
  console.log(`  id: ${targetModel.id}`);
  console.log(`  provider: ${targetModel.provider}`);
  console.log(`  input: ${JSON.stringify(targetModel.input)}`);
  console.log(`  text-only: ${!targetModel.input?.includes('image')}`);
  console.log();

  // 5. Test: process a mock image through the vision bridge
  const testImage = {
    type: 'image' as const,
    data: TEST_PNG_BASE64,
    mimeType: 'image/png',
  };

  const userText = '请问这张图片里面有什么？';

  console.log('Sending to Vision Bridge...');
  const startTime = Date.now();

  const result = await bridge.bridge(userText, [testImage], targetModel);

  const duration = Date.now() - startTime;
  console.log(`\nBridge result (${duration}ms):`);
  console.log(`  usedBridge: ${result.usedBridge}`);
  console.log(`  original input: "${userText}"`);
  console.log(`  modified input length: ${result.text.length} chars`);
  console.log();

  if (result.usedBridge) {
    console.log('=== Modified Input (sent to target model) ===');
    console.log(result.text);
    console.log('=== End ===');
  } else {
    console.log('Bridge was NOT used. The target model may already support images.');
  }

  // 6. Extra: test the full flow by sending the modified text to DeepSeek-V4
  if (result.usedBridge) {
    console.log('\n---\n');
    console.log('Now sending the vision-augmented text to DeepSeek-V4...\n');

    const response = await streamSimple(
      targetModel,
      {
        systemPrompt: '你是一个有帮助的AI助手。如果消息中有 VISION_CONTEXT 标签包裹的图片分析，请参考其中的信息来回答用户问题。',
        messages: [
          { role: 'user', content: [{ type: 'text', text: result.text }], timestamp: Date.now() },
        ],
        tools: [],
      },
      {
        apiKey: appConfig.piAi.apiKey,
        signal: AbortSignal.timeout(60000),
        maxTokens: 500,
      },
    );

    let answer = '';
    for await (const event of response) {
      if (event.type === 'text_delta') {
        process.stdout.write(event.delta);
        answer += event.delta;
      }
    }
    console.log('\n--- Done ---');
  }

  console.log('\n=== Test Complete ===');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
