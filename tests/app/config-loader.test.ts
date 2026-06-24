import { describe, it, expect } from 'vitest';
import { loadYamlFile, yamlToAppConfigRaw } from '../../src/app/config-loader';

describe('yamlToAppConfigRaw', () => {
  const minimalYaml = {
    provider: {
      primary: 'openai/gpt-4o',
      api_key: 'sk-test-key',
    },
    channels: {
      feishu: {
        enabled: true,
        app_id: 'cli_test',
        app_secret: 'test-secret',
      },
    },
  };

  it('maps provider.primary to piAi.provider and piAi.model', () => {
    const raw = yamlToAppConfigRaw(minimalYaml);
    expect(raw.piAi).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      reasoningModel: '', // defaults to empty (no fallback to primary)
      apiKey: 'sk-test-key',
      baseUrl: undefined,
    });
  });

  it('maps provider.reasoning to piAi.reasoningModel', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      provider: { ...minimalYaml.provider, reasoning: 'openai/gpt-4o-mini' },
    });
    expect(raw.piAi.reasoningModel).toBe('gpt-4o-mini');
  });

  it('maps channels.feishu to feishu', () => {
    const raw = yamlToAppConfigRaw(minimalYaml);
    expect(raw.feishu).toEqual({
      enabled: true,
      appId: 'cli_test',
      appSecret: 'test-secret',
      region: 'feishu',
      verificationToken: '',
      encryptKey: '',
      wsEnabled: true,
    });
  });

  it('sets wsEnabled false for webhook', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      channels: {
        feishu: {
          app_id: 'cli_test',
          app_secret: 'test-secret',
          connection_mode: 'webhook',
        },
      },
    });
    expect(raw.feishu.wsEnabled).toBe(false);
  });

  it('maps fallback_models to fallbackModels array', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      fallback_models: ['xiaomi/mimo-v2.5', 'deepseek/deepseek-chat'],
    });
    expect(raw.fallbackModels).toEqual(['xiaomi/mimo-v2.5', 'deepseek/deepseek-chat']);
  });

  it('defaults fallbackModels to empty array', () => {
    const raw = yamlToAppConfigRaw(minimalYaml);
    expect(raw.fallbackModels).toEqual([]);
  });

  it('defaults footer usage display options off', () => {
    const raw = yamlToAppConfigRaw(minimalYaml);
    expect(raw.footer.showUsage).toBe(false);
    expect(raw.footer.showCacheHitRate).toBe(false);
  });

  it('maps footer usage display options', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      footer: {
        show_usage: true,
        show_cache_hit_rate: true,
      },
    });
    expect(raw.footer.showUsage).toBe(true);
    expect(raw.footer.showCacheHitRate).toBe(true);
  });

  it('maps custom_providers', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      custom_providers: {
        'ai-next': {
          api_key: 'sk-xxx',
          base_url: 'https://api.ai-next.top/v1',
          models: [
            {
              id: 'gpt-5.4',
              name: 'GPT-5.4',
              api: 'openai-responses',
              reasoning: true,
              max_tokens: 128000,
              compat: {
                send_session_affinity_headers: true,
                supports_long_cache_retention: true,
              },
              cost: { input: 0, output: 0 },
            },
          ],
        },
      },
    });
    expect(raw.customProviders).toHaveLength(1);
    expect(raw.customProviders[0]).toMatchObject({
      provider: 'ai-next',
      apiKey: 'sk-xxx',
      baseUrl: 'https://api.ai-next.top/v1',
    });
    expect(raw.customProviders[0].models[0].compat).toMatchObject({
      sendSessionAffinityHeaders: true,
      supportsLongCacheRetention: true,
    });
  });

  it('maps telegram channel config', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      channels: {
        ...minimalYaml.channels,
        telegram: {
          enabled: true,
          bot_token: '123:abc',
          proxy_url: 'http://127.0.0.1:7897',
        },
      },
    });
    expect(raw.telegram.botToken).toBe('123:abc');
    expect(raw.telegram.proxyUrl).toBe('http://127.0.0.1:7897');
    expect(raw.telegram.mode).toBe('polling'); // default
  });

  it('maps wechat channel config', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      channels: {
        ...minimalYaml.channels,
        wechat: {
          enabled: true,
          bot_token: 'test-token',
        },
      },
    });
    expect(raw.wechat.enabled).toBe(true);
    expect(raw.wechat.botToken).toBe('test-token');
  });

  it('maps qq channel config', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      channels: {
        ...minimalYaml.channels,
        qq: {
          enabled: true,
          app_id: '123',
          client_secret: 'secret',
        },
      },
    });
    expect(raw.qq.enabled).toBe(true);
    expect(raw.qq.appId).toBe('123');
    expect(raw.qq.clientSecret).toBe('secret');
  });

  it('maps tools config with nested shell settings', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      tools: {
        profile: 'advanced',
        shell: {
          exec_mode: 'trusted',
          allowlist: ['adb', 'date', 'ls'],
          approval_timeout_sec: 300,
        },
      },
    });
    expect(raw.tools.toolsProfile).toBe('advanced');
    expect(raw.tools.shellExecMode).toBe('trusted');
    expect(raw.tools.shellAllowlist).toEqual(['adb', 'date', 'ls']);
    expect(raw.tools.shellApprovalTimeoutSec).toBe(300);
  });

  it('maps memory config', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      memory: {
        auto_recall: true,
        summarize_interval: 5,
        output_language: 'Simplified Chinese',
      },
    });
    expect(raw.memory.autoRecall).toBe(true);
    expect(raw.memory.summarizeInterval).toBe(5);
    expect(raw.memory.outputLanguage).toBe('Simplified Chinese');
  });

  it('uses memory defaults', () => {
    const raw = yamlToAppConfigRaw(minimalYaml);
    expect(raw.memory.autoRecall).toBe(false);
    expect(raw.memory.summarizeInterval).toBe(20);
    expect(raw.memory.outputLanguage).toBe('Auto');
    expect(raw.memory.persona.distillThreshold).toBe(3);
    expect(raw.memory.persona.minDistillIntervalHours).toBe(0);
  });

  it('maps memory.expansion from YAML snake_case', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      memory: {
        expansion: {
          enabled: true,
          min_query_length: 8,
          min_score_trigger: 0.45,
          max_variants: 6,
        },
      },
    });
    expect(raw.memory.expansion.enabled).toBe(true);
    expect(raw.memory.expansion.minQueryLength).toBe(8);
    expect(raw.memory.expansion.minScoreTrigger).toBe(0.45);
    expect(raw.memory.expansion.maxVariants).toBe(6);
  });

  it('defaults memory.expansion to disabled', () => {
    const raw = yamlToAppConfigRaw(minimalYaml);
    expect(raw.memory.expansion.enabled).toBe(false);
    expect(raw.memory.expansion.minScoreTrigger).toBe(0.3);
  });

  it('maps persona distillation config including zero interval', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      memory: {
        persona: {
          enabled: true,
          distill_threshold: 4,
          min_distill_interval_hours: 0,
        },
      },
    });
    expect(raw.memory.persona.enabled).toBe(true);
    expect(raw.memory.persona.distillThreshold).toBe(4);
    expect(raw.memory.persona.minDistillIntervalHours).toBe(0);
  });

  it('maps vision_bridge config', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      vision_bridge: {
        enabled: true,
        model_ref: 'openai/gpt-4o-mini',
        timeout_ms: 60000,
      },
    });
    expect(raw.visionBridge.enabled).toBe(true);
    expect(raw.visionBridge.modelRef).toBe('openai/gpt-4o-mini');
    expect(raw.visionBridge.timeoutMs).toBe(60000);
  });

  it('sets visionBridge undefined when not configured', () => {
    const raw = yamlToAppConfigRaw(minimalYaml);
    expect(raw.visionBridge).toBeUndefined();
  });

  it('maps agents from YAML map to array', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      agents: {
        default: {
          name: 'Default',
          system_prompt: 'You are helpful.',
        },
        coder: {
          name: 'Coder',
          tools: { profile: 'advanced' },
          model: { primary: 'deepseek/deepseek-chat' },
        },
      },
    });
    expect(raw.agents).toHaveLength(2);
    const defaultAgent = raw.agents.find((a: any) => a.id === 'default');
    expect(defaultAgent.name).toBe('Default');
    expect(defaultAgent.system_prompt).toBe('You are helpful.');
    const coder = raw.agents.find((a: any) => a.id === 'coder');
    expect(coder.name).toBe('Coder');
    expect(coder.tools.profile).toBe('advanced');
    expect(coder.model.primary).toBe('deepseek/deepseek-chat');
  });

  it('maps log_level to logging.level', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      log_level: 'debug',
    });
    expect(raw.logging.level).toBe('debug');
  });

  it('maps ui_language and show_tool_calls', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      ui_language: 'zh-CN',
      show_tool_calls: false,
    });
    expect(raw.uiLanguage).toBe('zh-CN');
    expect(raw.showToolCalls).toBe(false);
  });

  it('converts string booleans in envBool fields', () => {
    const raw = yamlToAppConfigRaw({
      ...minimalYaml,
      show_tool_calls: 'false',
      memory: { auto_recall: 'true' },
    });
    expect(raw.showToolCalls).toBe(false);
    expect(raw.memory.autoRecall).toBe(true);
  });

  it('handles empty YAML with only required defaults filled', () => {
    const raw = yamlToAppConfigRaw({ provider: { primary: 'test/model', api_key: 'k' }, channels: { feishu: { app_id: 'a', app_secret: 's' } } });
    expect(raw.logging.level).toBe('info');
    expect(raw.uiLanguage).toBe('en');
    expect(raw.showToolCalls).toBe(true);
    expect(raw.database.path).toBe('~/.ohmyagent/data/app.db');
  });
});

describe('loadYamlFile', () => {
  it('returns null for non-existent file', () => {
    const result = loadYamlFile('./nonexistent-file.yaml');
    expect(result).toBeNull();
  });
});
