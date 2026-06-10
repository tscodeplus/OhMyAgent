/**
 * E2E: Authentication flow
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('WebUI Authentication', () => {
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    baseUrl = `http://localhost:${process.env.OHMYAGENT_PORT || '9191'}`;
    // For tests, use WEBUI_TOKEN from env or a test token
    token = process.env.WEBUI_TOKEN || 'test-token';
  });

  it('GET /api/health returns ok without auth', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  it('GET /api/projects without auth returns 401', async () => {
    const response = await fetch(`${baseUrl}/api/projects`);
    expect(response.status).toBe(401);
  });

  it('POST /api/auth/login with wrong token returns 401', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token' }),
    });
    expect(response.status).toBe(401);
  });

  it('API requests with valid token succeed', async () => {
    const response = await fetch(`${baseUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Should return agent list (may be empty)
    expect(response.ok).toBe(true);
  });
});
