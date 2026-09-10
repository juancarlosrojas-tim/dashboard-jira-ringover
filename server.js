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

// Lista todos los campos de Jira (estándar + personalizados) con su id y nombre.
// La necesitamos una sola vez: para encontrar el id real del campo
// "Scoring_documentacion" que usaba el dashboard anterior (los campos
// personalizados en la API no se llaman por su nombre, sino "customfield_XXXXX").
// Abre esta URL y busca "scoring" o "documentacion" (Ctrl+F) para encontrarlo.
app.get('/api/jira/fields', async (req, res) => {
  if (!JIRA_SITE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(500).json({ ok: false, error: 'Faltan variables de entorno de Jira en el servidor del proxy.' });
  }

  try {
    const r = await fetch(`${JIRA_SITE_URL}/rest/api/3/field`, {
      headers: { Authorization: jiraAuthHeader(), Accept: 'application/json' },
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, jiraStatus: r.status, jiraBody: body });
    }

    const fields = body
      .map((f) => ({ id: f.id, name: f.name, custom: f.custom }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ ok: true, count: fields.length, fields });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'No se pudo contactar a Jira desde el proxy.', detail: err.message });
  }
});

const SCORING_FIELD = 'customfield_12343'; // Scoring_documentacion

const EXCLUDED_TECHNICIANS = [
  'Juan Carlos Rojas',
  'Cristina Martínez',
  'Estefania Fernández',
  'Judit Ferrero',
];

function isExcluded(displayName) {
  if (!displayName) return false;
  const n = displayName.toLowerCase();
  return EXCLUDED_TECHNICIANS.some((ex) => n.includes(ex.toLowerCase()));
}

// El scoring viene en dos escalas mezcladas (1-10 y 1-100) — se normaliza
// igual que en el dashboard anterior: > 10 se divide entre 10.
function normalizeScoring(raw) {
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  return n > 10 ? n / 10 : n;
}

const FCR_MAX_MINUTES = 60;

// FCR = resuelta en menos de 1 hora desde que se creó. Los nombres de estado
// (L2 - Resuelta / Partner Resuelto / Desestimado) ya no sirven como criterio
// porque toda resolución en este proyecto pasa por L2 — se cambió a esta regla
// por decisión explícita de Juan Carlos (10 sept 2026).
function isFCR(issue) {
  if (!issue.created || !issue.resolved) return false;
  const minutes = (new Date(issue.resolved).getTime() - new Date(issue.created).getTime()) / 60000;
  return minutes >= 0 && minutes <= FCR_MAX_MINUTES;
}

// Trae TODAS las issues de un proyecto tocadas en la ventana de días (creadas
// o resueltas), con los campos necesarios para calcular KPIs por técnico.
// Usa el endpoint nuevo de búsqueda (POST + nextPageToken, ya que Jira retiró
// el startAt/total del buscador clásico).
async function fetchIssuesDetail(project, days) {
  const jql = `project = "${project}" AND (created >= -${days}d OR resolutiondate >= -${days}d)`;
  const fields = ['assignee', 'status', 'labels', 'created', 'resolutiondate', SCORING_FIELD];

  let issues = [];
  let nextPageToken = undefined;
  let guard = 0;

  do {
    const r = await fetch(`${JIRA_SITE_URL}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: jiraAuthHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jql,
        fields,
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });

    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }

    if (!r.ok) {
      const err = new Error(`Jira respondió ${r.status} buscando issues de ${project}`);
      err.jiraStatus = r.status;
      err.jiraBody = body;
      throw err;
    }

    const pageIssues = (body.issues || []).map((raw) => ({
      key: raw.key,
      assignee: raw.fields?.assignee?.displayName || null,
      status: raw.fields?.status?.name || null,
      labels: raw.fields?.labels || [],
      created: raw.fields?.created || null,
      resolved: raw.fields?.resolutiondate || null,
      scoring: normalizeScoring(raw.fields?.[SCORING_FIELD]),
    }));

    issues = issues.concat(pageIssues);
    nextPageToken = body.nextPageToken || undefined;
    guard += 1;
    // Tope de seguridad: 20 páginas x 100 = 2000 issues. Suficiente para un
    // mes de un proyecto; si algún día hace falta más, se sube este límite.
  } while (nextPageToken && guard < 20);

  return issues;
}

// KPIs reales por técnico y totales del proyecto: creadas, resueltas, FCR%,
// scoring promedio. Excluye a los técnicos que no deben contarse.
//
// Ejemplo: /api/jira/technicians?project=ITRKFC&days=30
app.get('/api/jira/technicians', async (req, res) => {
  if (!JIRA_SITE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(500).json({ ok: false, error: 'Faltan variables de entorno de Jira en el servidor del proxy.' });
  }

  const project = req.query.project;
  const days = parseInt(req.query.days, 10) || 30;

  if (!project) {
    return res.status(400).json({ ok: false, error: 'Falta el parámetro ?project= (ej: ITRKFC)' });
  }

  try {
    const issues = await fetchIssuesDetail(project, days);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const byTech = new Map();
    const statusBreakdown = new Map(); // diagnóstico: qué "Estado" tienen las issues resueltas

    function bucket(name) {
      if (!byTech.has(name)) {
        byTech.set(name, { technician: name, created: 0, resolved: 0, fcr: 0, scoringSum: 0, scoringCount: 0 });
      }
      return byTech.get(name);
    }

    for (const issue of issues) {
      if (isExcluded(issue.assignee)) continue;
      const tech = issue.assignee || 'Sin asignar';
      const b = bucket(tech);

      const createdInWindow = issue.created && new Date(issue.created).getTime() >= cutoff;
      const resolvedInWindow = issue.resolved && new Date(issue.resolved).getTime() >= cutoff;

      if (createdInWindow) b.created += 1;
      if (resolvedInWindow) {
        b.resolved += 1;
        const sName = issue.status || '(sin estado)';
        statusBreakdown.set(sName, (statusBreakdown.get(sName) || 0) + 1);
        if (isFCR(issue)) b.fcr += 1;
        if (issue.scoring !== null) {
          b.scoringSum += issue.scoring;
          b.scoringCount += 1;
        }
      }
    }

    const technicians = Array.from(byTech.values())
      .map((b) => ({
        technician: b.technician,
        created: b.created,
        resolved: b.resolved,
        fcrRate: b.resolved > 0 ? Math.round((b.fcr / b.resolved) * 100) : null,
        avgScoring: b.scoringCount > 0 ? Math.round((b.scoringSum / b.scoringCount) * 10) / 10 : null,
      }))
      .sort((a, b) => b.resolved - a.resolved);

    const totals = technicians.reduce(
      (acc, t) => ({ created: acc.created + t.created, resolved: acc.resolved + t.resolved }),
      { created: 0, resolved: 0 }
    );

    res.json({
      ok: true,
      project,
      days,
      totals,
      technicians,
      statusBreakdownOfResolved: Object.fromEntries(statusBreakdown),
    });
  } catch (err) {
    res.status(err.jiraStatus || 502).json({ ok: false, error: err.message, jiraBody: err.jiraBody });
  }
});

app.listen(PORT, () => {
  console.log(`\nProxy escuchando en http://localhost:${PORT}`);
  console.log(`Prueba en el navegador: http://localhost:${PORT}/api/jira/me\n`);
});
