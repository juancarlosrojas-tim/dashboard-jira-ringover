// Proxy mínimo. Un único endpoint por ahora: /api/jira/me
// Objetivo de este tramo: confirmar que el patrón navegador -> proxy -> Jira
// funciona de punta a punta, con el mismo diagnóstico claro que ya probamos
// en scripts/test-jira-connection.js, antes de sumar más endpoints o desplegar.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN, PORT = 3001 } = process.env;

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

function jiraAuthHeader() {
  return 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'jira-ringover-proxy', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.type('html').send(`
    <html>
      <head><title>Dashboard Jira + Ringover — Proxy</title></head>
      <body style="font-family: sans-serif; max-width: 640px; margin: 60px auto; line-height: 1.6;">
        <h2>✅ Proxy activo</h2>
        <p>Este servidor está corriendo, pero no es el dashboard visual todavía — eso viene en un paso posterior. Por ahora expone estos endpoints:</p>
        <ul>
          <li><a href="/health">/health</a> — estado del servidor</li>
          <li><a href="/api/jira/me">/api/jira/me</a> — prueba de conexión a Jira (tu usuario y accountId)</li>
        </ul>
      </body>
    </html>
  `);
});

app.get('/api/jira/me', async (req, res) => {
  if (!JIRA_SITE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: 'Faltan variables de entorno de Jira (JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN) en el servidor del proxy.',
    });
  }

  const endpoint = `${JIRA_SITE_URL}/rest/api/3/myself`;

  try {
    const jiraRes = await fetch(endpoint, {
      headers: {
        Authorization: jiraAuthHeader(),
        Accept: 'application/json',
      },
    });

    const bodyText = await jiraRes.text();
    let body;
    try { body = JSON.parse(bodyText); } catch { body = bodyText; }

    if (!jiraRes.ok) {
      return res.status(jiraRes.status).json({
        ok: false,
        jiraStatus: jiraRes.status,
        jiraBody: body,
      });
    }

    res.json({
      ok: true,
      displayName: body.displayName,
      email: body.emailAddress,
      accountId: body.accountId,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: 'No se pudo contactar a Jira desde el proxy.',
      detail: err.message,
    });
  }
});

// Cuenta issues creadas vs resueltas para un proyecto en una ventana de días.
// No trae el detalle de cada issue todavía (eso vendrá después) — este tramo
// solo confirma que las búsquedas JQL funcionan desde el proxy.
//
// Ejemplo: /api/jira/issues?project=ITRKFC&days=30
app.get('/api/jira/issues', async (req, res) => {
  if (!JIRA_SITE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(500).json({ ok: false, error: 'Faltan variables de entorno de Jira en el servidor del proxy.' });
  }

  const project = req.query.project;
  const days = parseInt(req.query.days, 10) || 30;

  if (!project) {
    return res.status(400).json({ ok: false, error: 'Falta el parámetro ?project= (ej: ITRKFC)' });
  }

  // Jira retiró el "total" del endpoint de búsqueda clásico; el reemplazo
  // oficial es este endpoint dedicado a contar (POST, con la JQL en el body).
  async function jqlCount(jql) {
    const url = `${JIRA_SITE_URL}/rest/api/3/search/approximate-count`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: jiraAuthHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jql }),
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!r.ok) {
      const err = new Error(`Jira respondió ${r.status} para JQL: ${jql}`);
      err.jiraStatus = r.status;
      err.jiraBody = body;
      throw err;
    }
    if (typeof body?.count !== 'number') {
      const err = new Error(`Respuesta inesperada de approximate-count (sin campo "count") para JQL: ${jql}`);
      err.jiraStatus = 502;
      err.jiraBody = body;
      throw err;
    }
    return body.count;
  }

  const jqlCreated = `project = "${project}" AND created >= -${days}d`;
  const jqlResolved = `project = "${project}" AND resolutiondate >= -${days}d`;

  try {
    const [created, resolved] = await Promise.all([
      jqlCount(jqlCreated),
      jqlCount(jqlResolved),
    ]);
    res.json({ ok: true, project, days, created, resolved });
  } catch (err) {
    res.status(err.jiraStatus || 502).json({
      ok: false,
      error: err.message,
      jiraBody: err.jiraBody,
    });
  }
});

app.listen(PORT, () => {
  console.log(`\nProxy escuchando en http://localhost:${PORT}`);
  console.log(`Prueba en el navegador: http://localhost:${PORT}/api/jira/me\n`);
});
