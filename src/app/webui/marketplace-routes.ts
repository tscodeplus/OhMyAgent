/**
 * Marketplace API Routes
 *
 * Endpoints for searching and installing skills from skills.sh and skillhub.cn.
 */

import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../types.js';
import { SkillMarketplace } from '../../skills/skill-marketplace.js';

interface MarketplaceRouteConfig {
  services: Pick<AppServices, 'skillRegistry'>;
}

export function registerMarketplaceRoutes(app: FastifyInstance, cfg: MarketplaceRouteConfig): void {
  const marketplace = new SkillMarketplace(cfg.services.skillRegistry);

  /** Search skills across marketplaces */
  app.get<{
    Querystring: { q?: string; source?: string; limit?: string };
  }>('/api/marketplace/search', async (request, reply) => {
    try {
      const query = request.query.q?.trim();
      if (!query) {
        return reply.status(400).send({ error: 'Query parameter "q" is required' });
      }

      const source = (request.query.source as 'skills.sh' | 'skillhub' | 'all') || 'all';
      const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 50);

      const result = await marketplace.search(query, source, limit);
      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Get popular/trending skills */
  app.get<{
    Querystring: { source?: string; limit?: string };
  }>('/api/marketplace/popular', async (request, reply) => {
    try {
      const source = (request.query.source as 'skills.sh' | 'skillhub' | 'all') || 'all';
      const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 50);

      const results = await marketplace.getPopular(source, limit);
      return reply.send({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Install a skill from the marketplace */
  app.post<{
    Body: { package: string; source: 'skills.sh' | 'skillhub' };
  }>('/api/marketplace/install', async (request, reply) => {
    try {
      const { package: pkg, source } = request.body;

      if (!pkg || !source) {
        return reply.status(400).send({ error: '"package" and "source" are required' });
      }

      if (source !== 'skills.sh' && source !== 'skillhub') {
        return reply.status(400).send({ error: 'source must be "skills.sh" or "skillhub"' });
      }

      const result = await marketplace.install(pkg, source);

      if (!result.success) {
        return reply.status(422).send(result);
      }

      return reply.status(201).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });
}
