/**
 * Dashboard and Channel API Routes
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

interface DashboardConfig {
  db: Database.Database;
  getConfig: () => any;
  getChannelStatus?: () => Record<string, { running: boolean; mode?: string }>;
}

export function registerDashboardRoutes(app: FastifyInstance, cfg: DashboardConfig): void {
  // Dashboard stats
  app.get('/api/dashboard/stats', async (_request, reply) => {
    const db = cfg.db;

    // Active projects count
    const projectCount = (db.prepare('SELECT COUNT(*) as count FROM projects').get() as any).count;

    // Today's sessions
    const todaySessions = (db.prepare(
      "SELECT COUNT(*) as count FROM sessions WHERE project_id IS NOT NULL AND date(created_at) = date('now')"
    ).get() as any).count;

    // Monthly token count (from message metadata)
    const monthlyTokens = (db.prepare(`
      SELECT COALESCE(SUM(CAST(COALESCE(json_extract(metadata, '$.usage.total_tokens'), '0') AS INTEGER)), 0) as total
      FROM messages
      WHERE created_at >= datetime('now', '-30 days')
    `).get() as any).total;

    return reply.send({
      activeProjects: projectCount,
      todaySessions,
      monthlyTokens: Number(monthlyTokens),
    });
  });

  // Token usage by day
  app.get('/api/dashboard/token-usage', async (_request, reply) => {
    const db = cfg.db;
    const rows = db.prepare(`
      SELECT date(created_at) as day, role, COUNT(*) as count
      FROM messages
      WHERE created_at >= datetime('now', '-30 days')
      GROUP BY date(created_at), role
      ORDER BY day ASC
    `).all() as any[];

    return reply.send(rows);
  });
}
