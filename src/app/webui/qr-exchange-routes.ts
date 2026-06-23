/**
 * QR Exchange Routes — credential submission pages for QR-based channel setup.
 *
 * These are lightweight mobile-friendly HTML pages served at /qr-exchange/*.
 * When a user scans a QR code from the settings UI, their phone browser opens
 * one of these pages. The user pastes their channel credentials (obtained from
 * the platform's developer console) and submits them back to the server.
 *
 * The credential submit endpoint is POST /api/channels/:channel/qr/submit,
 * which is excluded from webui auth — the session ID in the URL serves as a
 * one-time bearer token.
 */

import type { FastifyInstance } from 'fastify';
import type { QrSessionStore } from '../../channel/qr-session-store.js';

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function basePage(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 20px;
  }
  .card {
    background: #fff;
    border-radius: 12px;
    padding: 24px;
    max-width: 380px;
    width: 100%;
    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  }
  h2 { font-size: 18px; margin-bottom: 8px; color: #1a1a1a; }
  p { font-size: 14px; color: #666; margin-bottom: 16px; line-height: 1.5; }
  label { display: block; font-size: 13px; font-weight: 600; color: #333; margin-bottom: 4px; margin-top: 12px; }
  input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    font-size: 14px;
    outline: none;
    transition: border-color 0.2s;
  }
  input:focus { border-color: #3b82f6; }
  button {
    width: 100%;
    margin-top: 20px;
    padding: 12px;
    background: #3b82f6;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }
  button:hover { background: #2563eb; }
  button:disabled { background: #9ca3af; cursor: not-allowed; }
  #result { margin-top: 12px; font-size: 13px; text-align: center; padding: 8px; border-radius: 6px; }
  .success { background: #d1fae5; color: #065f46; }
  .error { background: #fee2e2; color: #991b1b; }
</style>
</head>
<body>
<div class="card">
${bodyContent}
</div>
</body>
</html>`;
}

function feishuSetupPage(sessionId: string): string {
  return basePage('Feishu Bot Setup', `
<h2>&#x1F4E1; Feishu Bot Configuration</h2>
<p>Paste your Feishu bot credentials below. You can find them in the
<a href="https://open.feishu.cn/app" target="_blank">Feishu Developer Console</a>
under your app's "Credentials" section.</p>
<label for="appId">App ID</label>
<input id="appId" type="text" placeholder="cli_a..." autocomplete="off">
<label for="appSecret">App Secret</label>
<input id="appSecret" type="password" placeholder="Enter App Secret" autocomplete="off">
<button id="submitBtn" onclick="submitCreds('feishu')">Submit</button>
<div id="result"></div>
<script>
const sessionId = ${JSON.stringify(sessionId)};
${submitScript()}
</script>`);
}

function qqSetupPage(sessionId: string): string {
  return basePage('QQ Bot Setup', `
<h2>&#x1F4E2; QQ Bot Configuration</h2>
<p>Paste your QQ bot credentials below. You can find them in the
<a href="https://q.qq.com" target="_blank">QQ Open Platform</a>
under your bot's settings.</p>
<label for="appId">App ID</label>
<input id="appId" type="text" placeholder="Bot App ID" autocomplete="off">
<label for="clientSecret">Client Secret</label>
<input id="clientSecret" type="password" placeholder="Enter Client Secret" autocomplete="off">
<button id="submitBtn" onclick="submitCreds('qq')">Submit</button>
<div id="result"></div>
<script>
const sessionId = ${JSON.stringify(sessionId)};
${submitScript()}
</script>`);
}

function submitScript(): string {
  return `
async function submitCreds(channel) {
  const btn = document.getElementById('submitBtn');
  const result = document.getElementById('result');
  const appId = document.getElementById('appId').value.trim();
  const appSecret = document.getElementById('clientSecret')
    ? document.getElementById('clientSecret').value.trim()
    : document.getElementById('appSecret').value.trim();

  if (!appId || !appSecret) {
    result.className = 'error';
    result.textContent = 'Please fill in both fields';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Submitting...';
  result.className = '';
  result.textContent = '';

  try {
    const creds = {};
    if (channel === 'feishu') {
      creds.appId = appId; creds.appSecret = appSecret;
    } else if (channel === 'qq') {
      creds.appId = appId; creds.clientSecret = appSecret;
    }

    const resp = await fetch('/api/channels/' + channel + '/qr/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, credentials: creds })
    });

    if (resp.ok) {
      result.className = 'success';
      result.textContent = '\\u2705 Credentials submitted! You can close this page.';
      btn.textContent = 'Done';
    } else {
      const data = await resp.json().catch(() => ({}));
      result.className = 'error';
      result.textContent = data.error || 'Submission failed. Please try again.';
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  } catch (err) {
    result.className = 'error';
    result.textContent = 'Network error. Please check your connection and try again.';
    btn.disabled = false;
    btn.textContent = 'Retry';
  }
}
`;
}

function expiredPage(): string {
  return basePage('Session Expired', `
<h2>&#x23F0; Session Expired</h2>
<p>This QR configuration session has expired. Please generate a new QR code from the settings page.</p>`);
}

function notFoundPage(): string {
  return basePage('Not Found', `
<h2>&#x274C; Not Found</h2>
<p>This configuration session does not exist. Please generate a new QR code from the settings page.</p>`);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerQRExchangeRoutes(
  app: FastifyInstance,
  sessionStore: QrSessionStore,
): void {
  // Feishu credential exchange page
  app.get('/qr-exchange/feishu/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const session = sessionStore.get(sessionId);
    if (!session) {
      return reply.type('text/html').status(404).send(notFoundPage());
    }
    if (session.status === 'expired') {
      return reply.type('text/html').status(410).send(expiredPage());
    }
    return reply.type('text/html').send(feishuSetupPage(sessionId));
  });

  // QQ credential exchange page
  app.get('/qr-exchange/qq/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const session = sessionStore.get(sessionId);
    if (!session) {
      return reply.type('text/html').status(404).send(notFoundPage());
    }
    if (session.status === 'expired') {
      return reply.type('text/html').status(410).send(expiredPage());
    }
    return reply.type('text/html').send(qqSetupPage(sessionId));
  });

  // Credential submission endpoint (called by the setup pages)
  // No webui auth required — session ID is the one-time bearer token
  app.post('/api/channels/:channel/qr/submit', async (req, reply) => {
    const { channel } = req.params as { channel: string };
    const body = req.body as {
      sessionId?: string;
      credentials?: Record<string, string>;
    };

    if (!body.sessionId || !body.credentials || Object.keys(body.credentials).length === 0) {
      return reply.status(400).send({ ok: false, error: 'sessionId and credentials are required' });
    }

    if (!['feishu', 'wechat', 'qq', 'telegram'].includes(channel)) {
      return reply.status(400).send({ ok: false, error: 'Unknown channel' });
    }

    const session = sessionStore.get(body.sessionId);
    if (!session) {
      return reply.status(404).send({ ok: false, error: 'Session not found or expired' });
    }

    if (session.channel !== channel) {
      return reply.status(400).send({ ok: false, error: 'Channel mismatch' });
    }

    sessionStore.setCredentials(body.sessionId, body.credentials);
    return reply.send({ ok: true });
  });

  // Poll endpoint — also needs to be accessible without auth for the
  // frontend QRCodeModal polling (the frontend has auth, but WeChat iLink
  // polling is done server-side). We register a catch-all poll route here
  // that checks the QrSessionStore for submitted credentials (used by
  // Feishu/QQ credential exchange flow). Channel-specific poll routes
  // (WeChat iLink) are registered by each extension.
  //
  // This route is intentionally generic — extensions can override by
  // registering their own POST /api/channels/:channel/qr/poll first.
}
