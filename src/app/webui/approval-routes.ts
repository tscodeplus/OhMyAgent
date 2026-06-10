/**
 * WebUI Approval API Routes
 *
 * GET  /api/approvals/pending?sessionId=xxx  — list pending approvals for a session
 * POST /api/approvals/:id/resolve             — approve or reject an approval request
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { AgentService } from '../../agent/agent-service.js';
import type { ApprovalRequestRepository } from '../../memory/repositories/approval-request-repository.js';

interface ApprovalRouteConfig {
  agentService: AgentService;
  approvalRequestRepo?: ApprovalRequestRepository;
  db?: Database.Database;
}

export function registerApprovalRoutes(
  app: FastifyInstance,
  cfg: ApprovalRouteConfig,
): void {
  // List pending approval requests for a session
  app.get('/api/approvals/pending', async (request, reply) => {
    const { sessionId } = request.query as { sessionId?: string };
    if (!sessionId) {
      return reply.status(400).send({ error: 'sessionId query parameter is required' });
    }

    if (!cfg.approvalRequestRepo) {
      return reply.send({ approvals: [] });
    }

    const approvals = cfg.approvalRequestRepo.findBySessionKey(sessionId)
      .filter(a => a.status === 'pending')
      .map(a => ({
        id: a.id,
        toolName: a.tool_name,
        commandText: a.command_text ?? a.tool_name ?? '',
        riskLevel: a.risk_level ?? 'medium',
        reason: a.reason ?? '',
        expiresAt: a.expires_at,
        createdAt: a.created_at,
      }));

    return reply.send({ approvals });
  });

  // Resolve (approve / reject) an approval request
  app.post('/api/approvals/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { decision } = request.body as { decision?: string };

    if (!decision) {
      return reply.status(400).send({ error: 'decision is required' });
    }

    const validDecisions = [
      'approve_once', 'approve_session', 'approve_always',
      'reject_once', 'reject_always',
    ];

    if (!validDecisions.includes(decision)) {
      return reply.status(400).send({
        error: `Invalid decision. Must be one of: ${validDecisions.join(', ')}`,
      });
    }

    const resolved = cfg.agentService.resolveApproval(id, decision);

    if (!resolved) {
      return reply.status(404).send({
        error: 'Approval request not found or already resolved',
      });
    }

    // Update the persisted approval message status so it survives page refresh.
    // The message was created by createWebUIApprovalSender with id "approval-{id}".
    if (cfg.db) {
      try {
        const msgId = `approval-${id}`;
        const row = cfg.db.prepare(
          'SELECT metadata FROM messages WHERE id = ?',
        ).get(msgId) as { metadata: string | null } | undefined;
        if (row) {
          let meta: Record<string, unknown> = {};
          try { meta = row.metadata ? JSON.parse(String(row.metadata)) : {}; } catch { /* ignore */ }
          const approval = (meta.approval || {}) as Record<string, unknown>;
          const isApproved = decision.startsWith('approve');
          approval.status = isApproved ? 'approved' : 'rejected';
          approval.decision = decision;
          meta.approval = approval;
          cfg.db.prepare(
            'UPDATE messages SET metadata = ? WHERE id = ?',
          ).run(JSON.stringify(meta), msgId);
        }
      } catch (err) {
        console.warn('[approval-routes] Failed to update approval message:', err);
      }
    }

    return reply.send({ ok: true, requestId: id, decision });
  });
}
