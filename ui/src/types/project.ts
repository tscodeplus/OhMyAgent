export interface Project {
  id: string;
  name: string;
  description?: string;
  agent_id: string;
  /** INTEGER ms (from SQLite Date.now()) or legacy TEXT timestamp. */
  created_at: number | string;
  /** INTEGER ms (from SQLite Date.now()) or legacy TEXT timestamp. */
  updated_at: number | string;
}

export interface CreateProjectPayload {
  name: string;
  description?: string;
  agent_id: string;
}
