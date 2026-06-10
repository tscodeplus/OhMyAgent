/**
 * Project CRUD API Routes
 */

import type { FastifyInstance } from 'fastify';
import { ProjectStore } from './project-store.js';

export function registerProjectRoutes(app: FastifyInstance, store: ProjectStore): void {
  // List all projects
  app.get('/api/projects', async (_request, reply) => {
    const projects = store.list();
    return reply.send(projects);
  });

  // Get single project
  app.get('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = store.getById(id);
    if (!project) {
      return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    }
    return reply.send(project);
  });

  // Create project
  app.post('/api/projects', async (request, reply) => {
    const body = request.body as { name?: string; description?: string; agent_id?: string };

    if (!body.name?.trim()) {
      return reply.status(400).send({ error: 'Bad Request', message: 'name is required' });
    }
    if (body.name.trim().length > 50) {
      return reply.status(400).send({ error: 'Bad Request', message: 'name must be at most 50 characters' });
    }
    if (!body.agent_id?.trim()) {
      return reply.status(400).send({ error: 'Bad Request', message: 'agent_id is required' });
    }

    const project = store.create({
      name: body.name.trim(),
      description: body.description?.trim(),
      agent_id: body.agent_id.trim(),
    });

    return reply.status(201).send(project);
  });

  // Update project
  app.put('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; description?: string; agent_id?: string };

    const existing = store.getById(id);
    if (!existing) {
      return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    }

    if (body.name !== undefined && (body.name.trim().length === 0 || body.name.trim().length > 50)) {
      return reply.status(400).send({ error: 'Bad Request', message: 'name must be 1-50 characters' });
    }

    const updated = store.update(id, {
      name: body.name?.trim(),
      description: body.description?.trim(),
      agent_id: body.agent_id?.trim(),
    });

    return reply.send(updated);
  });

  // Delete project
  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = store.getById(id);
    if (!existing) {
      return reply.status(404).send({ error: 'Not Found', message: 'Project not found' });
    }

    const result = store.cascadeDelete(id);
    return reply.send({
      ok: true,
      deletedSessions: result.deletedSessions,
      deletedMemories: result.deletedMemories,
    });
  });
}
