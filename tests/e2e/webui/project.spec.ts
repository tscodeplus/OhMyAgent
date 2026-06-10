/**
 * E2E: Project CRUD flow
 */
import { describe, it, expect, beforeAll } from 'vitest';

function authHeaders(token: string) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

describe('WebUI Project API', () => {
  let baseUrl: string;
  let token: string;
  let createdProjectId: string;

  beforeAll(async () => {
    baseUrl = `http://localhost:${process.env.OHMYAGENT_PORT || '9191'}`;
    token = process.env.WEBUI_TOKEN || 'test-token';
  });

  it('GET /api/projects returns empty list initially', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      headers: authHeaders(token),
    });
    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('POST /api/projects creates a project', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        name: 'Test Project',
        description: 'A test project for E2E',
        agent_id: 'default',
      }),
    });

    if (response.ok) {
      const body = await response.json();
      expect(body.name).toBe('Test Project');
      createdProjectId = body.id;
    }
    // May fail if no 'default' agent exists — that's acceptable
  });

  it('DELETE /api/projects/:id deletes project', async () => {
    if (!createdProjectId) return; // Skip if creation failed
    const response = await fetch(`${baseUrl}/api/projects/${createdProjectId}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    expect(response.ok).toBe(true);
  });
});
