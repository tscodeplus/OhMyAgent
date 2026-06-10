/**
 * Agent CRUD API Routes
 *
 * Reads from / writes to config.agents[] and exposes agent list for WebUI.
 */

import type { FastifyInstance } from 'fastify';
import type { AppConfig, ToolProfileId } from '../types.js';

interface AgentRouteConfig {
  getConfig: () => AppConfig;
  onConfigChanged?: () => void;
}

export function registerAgentRoutes(app: FastifyInstance, cfg: AgentRouteConfig): void {
  // List all agents
  app.get('/api/agents', async (_request, reply) => {
    const config = cfg.getConfig();
    const agents = (config.agents || []).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      systemPrompt: a.system_prompt,
      model: a.model?.primary,
      fallbackModels: a.model?.fallback,
      reasoningLevel: a.model?.reasoning_level,
      transport: a.model?.transport,
      maxRetry: a.model?.max_retry,
      profile: a.tools?.profile,
      addTools: a.tools?.add,
      denyTools: a.tools?.deny,
      subAgent: a.spawn ? {
        enabled: a.spawn.enabled,
        maxParallel: a.spawn.max_parallel,
        allowedPersonas: a.spawn.allowed_personas,
      } : undefined,
      channelBindings: {
        feishu: a.channels?.includes('feishu') ? { triggerWords: [] } : undefined,
        telegram: a.channels?.includes('telegram'),
        wechat: a.channels?.includes('wechat'),
        qq: a.channels?.includes('qq'),
        webui: a.channels?.includes('webui'),
      },
      disabled: a.extensions?.disable,
    }));

    // When no agents are configured, expose the built-in fallback so users
    // can still create projects. Mirrors AgentManager.getDefault() behavior.
    if (agents.length === 0) {
      agents.push({
        id: 'default',
        name: 'Default',
        description: undefined,
        systemPrompt: 'You are a helpful AI assistant.',
        model: config.piAi ? `${config.piAi.provider}/${config.piAi.model}` : undefined,
        fallbackModels: undefined,
        reasoningLevel: undefined,
        transport: undefined,
        maxRetry: undefined,
        profile: 'advanced',
        addTools: undefined,
        denyTools: undefined,
        subAgent: undefined,
        channelBindings: { feishu: { triggerWords: [] }, telegram: true, wechat: true, qq: true, webui: true },
        disabled: undefined,
      });
    }

    return reply.send(agents);
  });

  // Get single agent
  app.get('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = cfg.getConfig();
    const agent = (config.agents || []).find((a) => a.id === id);
    if (!agent) {
      return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
    }
    return reply.send({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.system_prompt,
      model: agent.model?.primary,
      fallbackModels: agent.model?.fallback,
      channels: agent.channels,
    });
  });

  // Create agent (adds to in-memory config — requires config persistence)
  app.post('/api/agents', async (request, reply) => {
    const body = request.body as { id?: string; name?: string; description?: string; systemPrompt?: string; model?: string; channels?: string[] };

    if (!body.name?.trim()) {
      return reply.status(400).send({ error: 'Bad Request', message: 'name is required' });
    }

    const config = cfg.getConfig();
    const agentId = body.id?.trim() || body.name.trim().toLowerCase().replace(/\s+/g, '-');

    // Check for duplicate
    if (config.agents?.some((a) => a.id === agentId)) {
      return reply.status(409).send({ error: 'Conflict', message: `Agent with id '${agentId}' already exists` });
    }

    const newAgent: Record<string, unknown> = {
      id: agentId,
      name: body.name.trim(),
      description: body.description?.trim(),
      system_prompt: body.systemPrompt?.trim(),
      model: body.model ? { primary: body.model } : undefined,
      channels: body.channels,
    };

    // Profile / tools
    const tools: Record<string, unknown> = {};
    const bodyAny = body as Record<string, unknown>;
    if (bodyAny.profile) tools.profile = bodyAny.profile;
    if (bodyAny.addTools) tools.add = bodyAny.addTools;
    if (bodyAny.denyTools) tools.deny = bodyAny.denyTools;
    if (Object.keys(tools).length > 0) newAgent.tools = tools;

    // Mutate config in-memory (will be persisted by config-routes)
    if (!config.agents) config.agents = [];
    config.agents.push(newAgent as any);

    cfg.onConfigChanged?.();
    return reply.status(201).send({ id: agentId, name: body.name.trim() });
  });

  // Update agent (upsert — creates if editing the built-in fallback default)
  app.put('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; description?: string; systemPrompt?: string; model?: string; channels?: string[] };

    const config = cfg.getConfig();
    if (!config.agents) config.agents = [];
    let agent = config.agents.find((a) => a.id === id);

    if (agent) {
      // Update existing agent
      if (body.name) agent.name = body.name;
      if (body.description !== undefined) agent.description = body.description;
      if (body.systemPrompt !== undefined) agent.system_prompt = body.systemPrompt;
      if (body.model) agent.model = { ...agent.model, primary: body.model };
      if (body.channels) agent.channels = body.channels;

      // Profile / tools
      const bodyAny = body as Record<string, unknown>;
      if (bodyAny.profile !== undefined || bodyAny.addTools !== undefined || bodyAny.denyTools !== undefined) {
        if (!agent.tools) agent.tools = {};
        if (bodyAny.profile !== undefined) agent.tools.profile = bodyAny.profile as ToolProfileId;
        if (bodyAny.addTools !== undefined) agent.tools.add = bodyAny.addTools as string[];
        if (bodyAny.denyTools !== undefined) agent.tools.deny = bodyAny.denyTools as string[];
      }
    } else {
      // Upsert: create from fallback (e.g. built-in default agent first-time edit)
      agent = {
        id,
        name: body.name || id,
        description: body.description?.trim(),
        system_prompt: body.systemPrompt?.trim(),
        model: body.model ? { primary: body.model } : undefined,
        channels: body.channels || ['webui'],
      };
      config.agents.push(agent);
    }

    cfg.onConfigChanged?.();
    return reply.send(agent);
  });

  // Delete agent — checks for Project bindings
  app.delete('/api/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = cfg.getConfig();

    // The built-in default agent is always available as a fallback and cannot be deleted
    if (id === 'default') {
      return reply.status(409).send({ error: 'Conflict', message: 'The default agent cannot be deleted' });
    }

    const idx = (config.agents || []).findIndex((a) => a.id === id);
    if (idx === -1) {
      return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
    }

    // Check project bindings via project-store
    // The caller should inject a check function
    const checkBindings = (request as any).__checkAgentBindings as ((agentId: string) => string[]) | undefined;
    if (checkBindings) {
      const bindings = checkBindings(id);
      if (bindings.length > 0) {
        return reply.status(409).send({
          error: 'Conflict',
          message: `Agent is bound to ${bindings.length} project(s): ${bindings.join(', ')}`,
          projectIds: bindings,
        });
      }
    }

    config.agents!.splice(idx, 1);
    cfg.onConfigChanged?.();
    return reply.send({ ok: true });
  });
}
