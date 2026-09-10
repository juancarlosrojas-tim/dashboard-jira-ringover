// Proxy mínimo. Un único endpoint por ahora: /api/jira/me
// Objetivo de este tramo: confirmar que el patrón navegador -> proxy -> Jira
// funciona de punta a punta, con el mismo diagnóstico claro que ya probamos
// en scripts/test-jira-connection.js, antes de sumar más endpoints o desplegar.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const { JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN, PORT = 3001 } = process.env;

const app = express();
app.use(cors());

function jiraAuthHeader() {
  return 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'jira-ringover-proxy', time: new Date().toISOString() });
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

app.listen(PORT, () => {
  console.log(`\nProxy escuchando en http://localhost:${PORT}`);
  console.log(`Prueba en el navegador: http://localhost:${PORT}/api/jira/me\n`);
});
