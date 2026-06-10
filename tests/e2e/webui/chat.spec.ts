/**
 * E2E: Chat SSE streaming
 */
import { describe, it, expect, beforeAll } from 'vitest';

function authHeaders(token: string) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

describe('WebUI Chat API', () => {
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    baseUrl = `http://localhost:${process.env.OHMYAGENT_PORT || '9191'}`;
    token = process.env.WEBUI_TOKEN || 'test-token';
  });

  it('POST /api/projects/:id/chat validates required fields', async () => {
    const response = await fetch(`${baseUrl}/api/projects/nonexistent/chat`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ message: 'Hello' }),
    });
    // Should return 400 (missing sessionId) or 404 (project not found)
    expect([400, 404]).toContain(response.status);
  });

  it('POST /api/projects/:id/chat rejects without sessionId', async () => {
    const response = await fetch(`${baseUrl}/api/projects/test/chat`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(400);
  });

  it('GET /api/auth/verify validates token', async () => {
    const response = await fetch(`${baseUrl}/api/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body.valid).toBe(true);
  });
});
