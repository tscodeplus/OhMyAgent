/**
 * Skills Management API Routes
 *
 * CRUD endpoints for managing agent skills (SKILL.md files in the skills/ directory).
 * Read operations use SkillRegistry; write operations manipulate SKILL.md files directly
 * and trigger skill reload.
 *
 * SKILL.md frontmatter and body are handled separately so the UI can edit name/description
 * without risking YAML corruption of the full frontmatter block.
 */

import type { FastifyInstance } from 'fastify';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppServices } from '../types.js';

const SKILLS_DIR = resolve('./skills');

interface SkillsRouteConfig {
  services: AppServices;
}

// ---- Routes ----

export function registerSkillsRoutes(app: FastifyInstance, cfg: SkillsRouteConfig): void {
  /** List all loaded skills */
  app.get('/api/skills', async (_request, reply) => {
    try {
      const skills = cfg.services.skillRegistry.getSkills();
      const list = skills.map((s) => ({
        slug: s.manifest.id,
        name: s.manifest.name,
        description: s.manifest.description,
        version: s.manifest.version,
        path: s.path,
      }));
      return reply.send({ skills: list });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Read skill — returns raw SKILL.md content for editing */
  app.get<{ Params: { slug: string } }>('/api/skills/:slug', async (request, reply) => {
    try {
      const { slug } = request.params;
      const skill = cfg.services.skillRegistry.getSkillById(slug);
      if (!skill) {
        return reply.status(404).send({ error: `Skill "${slug}" not found` });
      }

      const skillMdPath = join(skill.path, 'SKILL.md');
      const content = await readFile(skillMdPath, 'utf-8');

      return reply.send({
        slug: skill.manifest.id,
        name: skill.manifest.name,
        description: skill.manifest.description,
        version: skill.manifest.version,
        path: skill.path,
        content,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Create new skill */
  app.post('/api/skills', async (request, reply) => {
    try {
      const { slug, name, description } = request.body as {
        slug: string;
        name: string;
        description?: string;
      };

      if (!slug || !name) {
        return reply.status(400).send({ error: 'slug and name are required' });
      }

      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(slug)) {
        return reply.status(400).send({ error: 'Invalid slug format' });
      }

      const skillDir = join(SKILLS_DIR, slug);
      if (existsSync(skillDir)) {
        return reply.status(409).send({ error: `Skill "${slug}" already exists` });
      }

      const desc = description || name;
      const content = `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nDescribe what ${name} does and how to use it.`;

      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), content, 'utf-8');

      await cfg.services.skillRegistry.load(SKILLS_DIR);

      return reply.status(201).send({ ok: true, slug, name, description: desc });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Update skill — writes raw SKILL.md content with rollback safety */
  app.put<{ Params: { slug: string } }>('/api/skills/:slug', async (request, reply) => {
    try {
      const { slug } = request.params;
      const { content } = request.body as { content?: string };

      const skill = cfg.services.skillRegistry.getSkillById(slug);
      if (!skill) {
        return reply.status(404).send({ error: `Skill "${slug}" not found` });
      }

      if (typeof content !== 'string') {
        return reply.status(400).send({ error: 'content is required' });
      }

      const skillMdPath = join(skill.path, 'SKILL.md');
      const original = await readFile(skillMdPath, 'utf-8');
      await writeFile(skillMdPath, content, 'utf-8');

      // Reload and verify — find by path (slug may have changed if user renamed the skill)
      await cfg.services.skillRegistry.load(SKILLS_DIR);
      const all = cfg.services.skillRegistry.getSkills();
      const reloaded = all.find((s) => s.path === skill.path);
      if (!reloaded) {
        // Rollback
        await writeFile(skillMdPath, original, 'utf-8');
        await cfg.services.skillRegistry.load(SKILLS_DIR);
        return reply.status(422).send({ error: 'Updated SKILL.md failed to load — original content restored. Check YAML syntax.' });
      }

      return reply.send({ ok: true, slug: reloaded.manifest.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Delete skill directory */
  app.delete<{ Params: { slug: string } }>('/api/skills/:slug', async (request, reply) => {
    try {
      const { slug } = request.params;

      const skill = cfg.services.skillRegistry.getSkillById(slug);
      if (!skill) {
        return reply.status(404).send({ error: `Skill "${slug}" not found` });
      }

      await rm(skill.path, { recursive: true, force: true });

      await cfg.services.skillRegistry.load(SKILLS_DIR);

      return reply.send({ ok: true, slug });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Read an auxiliary file inside a skill directory */
  app.get<{ Params: { slug: string } }>('/api/skills/:slug/file', async (request, reply) => {
    try {
      const { slug } = request.params;
      const { file } = request.query as { file?: string };

      const skill = cfg.services.skillRegistry.getSkillById(slug);
      if (!skill) {
        return reply.status(404).send({ error: `Skill "${slug}" not found` });
      }

      if (!file) {
        return reply.status(400).send({ error: 'file query param required' });
      }

      const filePath = join(skill.path, file);
      // Security: ensure resolved path is still under skill.path
      if (!resolve(filePath).startsWith(resolve(skill.path) + '/') && resolve(filePath) !== resolve(skill.path)) {
        return reply.status(403).send({ error: 'Path traversal denied' });
      }

      if (!existsSync(filePath)) {
        return reply.status(404).send({ error: `File "${file}" not found` });
      }

      const content = await readFile(filePath, 'utf-8');
      return reply.send({ slug, file, content });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** Write an auxiliary file inside a skill directory */
  app.put<{ Params: { slug: string } }>('/api/skills/:slug/file', async (request, reply) => {
    try {
      const { slug } = request.params;
      const { file, content } = request.body as { file?: string; content?: string };

      const skill = cfg.services.skillRegistry.getSkillById(slug);
      if (!skill) {
        return reply.status(404).send({ error: `Skill "${slug}" not found` });
      }

      if (!file || typeof content !== 'string') {
        return reply.status(400).send({ error: 'file and content required' });
      }

      const filePath = join(skill.path, file);
      if (!resolve(filePath).startsWith(resolve(skill.path) + '/')) {
        return reply.status(403).send({ error: 'Path traversal denied' });
      }

      await writeFile(filePath, content, 'utf-8');
      return reply.send({ ok: true, slug, file });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** P1-4: Skill usage metrics */
  app.get<{ Params: { slug: string } }>('/api/skills/:slug/metrics', async (request, reply) => {
    try {
      const { slug } = request.params;
      const metricsService = cfg.services.skillMetricsService;
      if (!metricsService) {
        return reply.status(501).send({ error: 'Metrics service not available' });
      }

      const stats = metricsService.getStats(slug);
      if (!stats) {
        return reply.status(404).send({ error: `No metrics data for skill "${slug}"` });
      }

      return reply.send(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** P1-4: Global skill metrics summary */
  app.get('/api/skills-metrics', async (_request, reply) => {
    try {
      const metricsService = cfg.services.skillMetricsService;
      if (!metricsService) {
        return reply.status(501).send({ error: 'Metrics service not available' });
      }

      const stats = metricsService.getGlobalStats();
      return reply.send(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** P2-2: Skill improvement proposals */
  app.get<{ Params: { slug: string } }>('/api/skills/:slug/proposals', async (request, reply) => {
    try {
      const { slug } = request.params;
      const metricsService = cfg.services.skillMetricsService;
      if (!metricsService) {
        return reply.status(501).send({ error: 'Metrics service not available' });
      }

      const { ProposalGenerator } = await import('../../skills/skill-evolution/proposal-generator.js');
      const generator = new ProposalGenerator(metricsService, cfg.services.skillRegistry);
      // Generate fresh proposals based on current metrics
      generator.generate(slug);
      const proposals = generator.getProposals(slug);

      return reply.send({ skillId: slug, proposals });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** P2-2: Get skill health report */
  app.get<{ Params: { slug: string } }>('/api/skills/:slug/health', async (request, reply) => {
    try {
      const { slug } = request.params;
      const metricsService = cfg.services.skillMetricsService;
      if (!metricsService) {
        return reply.status(501).send({ error: 'Metrics service not available' });
      }

      const { ProposalGenerator } = await import('../../skills/skill-evolution/proposal-generator.js');
      const generator = new ProposalGenerator(metricsService, cfg.services.skillRegistry);
      const report = generator.getHealthReport(slug);

      if (!report) {
        return reply.status(404).send({ error: `No health data for skill "${slug}"` });
      }

      return reply.send(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** P2-2: Apply a proposal (mark as applied, does NOT auto-modify SKILL.md) */
  app.post<{ Params: { slug: string; proposalId: string } }>('/api/skills/:slug/proposals/:proposalId/apply', async (request, reply) => {
    try {
      const { slug, proposalId } = request.params;
      const metricsService = cfg.services.skillMetricsService;
      if (!metricsService) {
        return reply.status(501).send({ error: 'Metrics service not available' });
      }

      const { ProposalGenerator } = await import('../../skills/skill-evolution/proposal-generator.js');
      const generator = new ProposalGenerator(metricsService, cfg.services.skillRegistry);
      const ok = generator.applyProposal(slug, proposalId);

      if (!ok) {
        return reply.status(404).send({ error: `Proposal "${proposalId}" not found` });
      }

      return reply.send({ ok: true, skillId: slug, proposalId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** P2-2: Dismiss a proposal */
  app.post<{ Params: { slug: string; proposalId: string } }>('/api/skills/:slug/proposals/:proposalId/dismiss', async (request, reply) => {
    try {
      const { slug, proposalId } = request.params;
      const metricsService = cfg.services.skillMetricsService;
      if (!metricsService) {
        return reply.status(501).send({ error: 'Metrics service not available' });
      }

      const { ProposalGenerator } = await import('../../skills/skill-evolution/proposal-generator.js');
      const generator = new ProposalGenerator(metricsService, cfg.services.skillRegistry);
      const ok = generator.dismissProposal(slug, proposalId);

      if (!ok) {
        return reply.status(404).send({ error: `Proposal "${proposalId}" not found` });
      }

      return reply.send({ ok: true, skillId: slug, proposalId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });
}
