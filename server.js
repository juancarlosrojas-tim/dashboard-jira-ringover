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

// Diagnóstico: muestra, para issues recientes de un proyecto, todos los
// customfields con valor (id + nombre humano + valor), para identificar el
// id real de un campo cuando no sabemos su nombre exacto (p.ej. "tipología").
// Ejemplo: /api/jira/debug-fields?project=ITRKFC
app.get('/api/jira/debug-fields', async (req, res) => {
  if (!JIRA_SITE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(500).json({ ok: false, error: 'Faltan variables de entorno de Jira en el servidor del proxy.' });
  }
  const project = req.query.project || 'ITRKFC';
  try {
    // Paso 1: buscar issues recientes con TODOS sus campos.
    const r = await fetch(`${JIRA_SITE_URL}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: jiraAuthHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jql: `project = "${project}" ORDER BY created DESC`,
        fields: ['*all'],
        maxResults: 5,
      }),
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, step: 'search', jiraBody: body });
    }

    const issues = body.issues || [];

    // Paso 2: sacar el mapa id -> nombre humano desde un issue concreto.
    let names = {};
    if (issues[0]) {
      const nr = await fetch(`${JIRA_SITE_URL}/rest/api/3/issue/${issues[0].key}?expand=names`, {
        headers: { Authorization: jiraAuthHeader(), Accept: 'application/json' },
      });
      const nText = await nr.text();
      let nBody;
      try { nBody = JSON.parse(nText); } catch { nBody = nText; }
      if (nr.ok) names = nBody.names || {};
    }

    const sample = issues.map((iss) => {
      const customFields = {};
      for (const [fid, val] of Object.entries(iss.fields || {})) {
        if (fid.startsWith('customfield_') && val !== null && val !== undefined) {
          customFields[fid] = { name: names[fid] || null, value: val };
        }
      }
      return { key: iss.key, customFields };
    });

    res.json({ ok: true, project, sample });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
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

// El scoring viene en escalas mezcladas (a veces 1-10, a veces cientos) — se
// divide entre 10 REPETIDAMENTE hasta caer entre 1 y 10 (76→7,6 ; 775→7,75).
function normalizeScoring(raw) {
  let n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  let guard = 0;
  while (n > 10 && guard < 10) {
    n = n / 10;
    guard += 1;
  }
  return n;
}

// Etiquetas internas permitidas — no cuentan como escalada a partner.
// Riesgo_* es un comodín (Riesgo_bajo, Riesgo_medio, Riesgo_alto, ...).
const INTERNAL_LABELS = ['QA_Desc_Done', 'Datafonos_triaje', 'ERROR_ESCALADO'];

function isInternalLabel(label) {
  const l = (label || '').toLowerCase();
  if (l.startsWith('riesgo_')) return true;
  return INTERNAL_LABELS.some((allowed) => l === allowed.toLowerCase());
}

// FCR = resuelta SIN ninguna etiqueta de partner. Las etiquetas internas
// (arriba) no cuentan como partner; cualquier otra etiqueta sí descalifica.
// Regla definitiva dictada por Juan Carlos (10 sept 2026), reemplaza el
// criterio de "resuelta en menos de 1 hora" usado provisionalmente antes.
function isFCR(issue) {
  const labels = issue.labels || [];
  return labels.every(isInternalLabel);
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

// ============================================================================
// Dashboard mensual multi-proyecto — réplica del dashboard anterior (carga
// manual), ahora con datos en vivo. Un solo endpoint que trae TODOS los
// proyectos para un mes y devuelve el desglose completo: total, por proyecto,
// por técnico, escaladas (partners), tipología (categorías/familias) y
// locales. El frontend (/dashboard) arma las 6 pestañas de la sección Jira
// a partir de esta única respuesta.
// ============================================================================

const PROJECTS = [
  { code: 'ITRKFC', name: 'KFC' },
  { code: 'ITHOSP', name: 'Hospitality' },
  { code: 'HLPGIHAR', name: 'Genéricos' },
  { code: 'HLPPRPAY', name: 'Prosegur' },
];

// Campo de "tipología del fallo". El dashboard anterior lo llamaba
// "Categorías KFC Amrest", pero ese nombre exacto ya no aparece en
// /api/jira/fields — probablemente fue renombrado. "Categorías IT"
// (customfield_10505) es el candidato más parecido por rango de id y
// vigencia; queda pendiente confirmar con datos reales una vez desplegado.
const CATEGORY_FIELD = 'customfield_10505'; // Categorías IT (¿antes "Categorías KFC Amrest"?)

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { start, end };
}

// El campo de tipología puede venir como texto simple, select {value}, o
// select en cascada {value, child:{value}} — normalizamos a "Familia - Hijo".
function extractCategoryValue(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) return raw.map(extractCategoryValue).filter(Boolean).join(' - ');
  if (typeof raw === 'object') {
    if (raw.value !== undefined) {
      let s = String(raw.value).trim();
      const child = raw.child ? extractCategoryValue(raw.child) : '';
      return child ? `${s} - ${child}` : s;
    }
    if (raw.name !== undefined) return String(raw.name).trim();
  }
  return '';
}

// Resuelta = campo Resolución en "resuelto"/"desestimado", o el Estado
// contiene "resuelt"/"desestimado" (nombres de estado varían por proyecto).
function esResuelta(issue) {
  const res = (issue.resolution || '').toLowerCase();
  const est = (issue.status || '').toLowerCase();
  return res === 'resuelto' || res === 'desestimado' || est.includes('resuelt') || est.includes('desestimado');
}

function partnersOf(issue) {
  const set = new Set();
  for (const l of issue.labels || []) {
    if (!isInternalLabel(l)) set.add(l.toUpperCase());
  }
  return Array.from(set).sort();
}

// FCR = resuelta sin ninguna etiqueta de partner (las internas no cuentan).
function isFCRv2(issue) {
  return esResuelta(issue) && partnersOf(issue).length === 0;
}

function diasEntre(createdIso, updatedIso) {
  if (!createdIso || !updatedIso) return null;
  const d = (new Date(updatedIso).getTime() - new Date(createdIso).getTime()) / 86400000;
  return d >= 0 ? d : null;
}

function round2(x) { return Math.round(x * 100) / 100; }
function round1(x) { return Math.round(x * 10) / 10; }

// El mismo bloque de KPIs que usaba el dashboard anterior, aplicado a
// cualquier subconjunto de issues (todas, por proyecto, por técnico, ...).
function bloque(subset) {
  let scoringSum = 0, scoringCount = 0, resueltas = 0, fcr = 0, escaladas = 0, diasSum = 0, diasCount = 0;
  for (const r of subset) {
    if (r.scoring !== null) { scoringSum += r.scoring; scoringCount += 1; }
    if (esResuelta(r)) resueltas += 1;
    if (isFCRv2(r)) fcr += 1;
    const partners = partnersOf(r);
    if (partners.length) {
      escaladas += 1;
      const d = diasEntre(r.created, r.updated);
      if (d !== null) { diasSum += d; diasCount += 1; }
    }
  }
  const creadas = subset.length;
  return {
    creadas,
    resueltas,
    abiertas: creadas - resueltas,
    fcr,
    fcrPct: resueltas ? round1((fcr / resueltas) * 100) : 0,
    escaladas,
    diasEscalada: diasCount ? round2(diasSum / diasCount) : 0,
    scoring: scoringCount ? round2(scoringSum / scoringCount) : null,
    nScore: scoringCount,
  };
}

function groupBy(subset, keyFn, excludeFn) {
  const g = new Map();
  for (const r of subset) {
    const k = keyFn(r);
    if (!k) continue;
    if (excludeFn && excludeFn(k)) continue;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  const entries = Array.from(g.entries()).sort((a, b) => b[1].length - a[1].length);
  const out = {};
  for (const [k, rows] of entries) out[k] = bloque(rows);
  return out;
}

function partnersBreakdown(issues) {
  const map = new Map();
  for (const r of issues) {
    const partners = partnersOf(r);
    if (!partners.length) continue;
    const d = diasEntre(r.created, r.updated);
    for (const p of partners) {
      if (!map.has(p)) map.set(p, []);
      map.get(p).push(d === null ? 0 : d);
    }
  }
  const entries = Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  const out = {};
  for (const [k, arr] of entries) {
    const avg = arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
    out[k] = { n: arr.length, dias: round2(avg) };
  }
  return out;
}

function categoryBreakdown(issues) {
  const cats = new Map(), fams = new Map();
  let nCategorizadas = 0;
  for (const r of issues) {
    const v = r.category;
    if (!v || v === 'No Procede') continue;
    nCategorizadas += 1;
    if (!cats.has(v)) cats.set(v, []);
    cats.get(v).push(r);
    const fam = v.split(' - ')[0].trim();
    if (!fams.has(fam)) fams.set(fam, []);
    fams.get(fam).push(r);
  }
  function toBloqueMap(map) {
    const entries = Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
    const out = {};
    for (const [k, rows] of entries) out[k] = bloque(rows);
    return out;
  }
  return { categorias: toBloqueMap(cats), familias: toBloqueMap(fams), nCategorizadas };
}

function localesBreakdown(issues) {
  const map = new Map();
  let nConLocal = 0;
  for (const r of issues) {
    const v = r.local;
    if (!v) continue;
    nConLocal += 1;
    if (!map.has(v)) map.set(v, []);
    map.get(v).push(r);
  }
  const entries = Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  const out = {};
  for (const [k, rows] of entries) out[k] = bloque(rows);
  return { locales: out, nConLocal };
}

// Trae las issues CREADAS en el mes dado, para un proyecto, con todos los
// campos que necesita el dashboard.
async function fetchIssuesForMonth(projectCode, month) {
  const { start, end } = monthRange(month);
  const jql = `project = "${projectCode}" AND created >= "${start}" AND created < "${end}"`;
  const fields = ['assignee', 'reporter', 'status', 'resolution', 'labels', 'created', 'updated', 'components', CATEGORY_FIELD, SCORING_FIELD];

  let issues = [];
  let nextPageToken;
  let guard = 0;

  do {
    const r = await fetch(`${JIRA_SITE_URL}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: jiraAuthHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }),
    });

    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }

    if (!r.ok) {
      const err = new Error(`Jira respondió ${r.status} buscando ${projectCode} (${month})`);
      err.jiraStatus = r.status;
      err.jiraBody = body;
      throw err;
    }

    const pageIssues = (body.issues || []).map((raw) => ({
      key: raw.key,
      project: projectCode,
      assignee: raw.fields?.assignee?.displayName || null,
      reporter: raw.fields?.reporter?.displayName || null,
      status: raw.fields?.status?.name || null,
      resolution: raw.fields?.resolution?.name || null,
      labels: raw.fields?.labels || [],
      created: raw.fields?.created || null,
      updated: raw.fields?.updated || null,
      local: (() => {
        const names = (raw.fields?.components || []).map((c) => c.name).filter(Boolean);
        return names.find((n) => n.toUpperCase() !== 'TODOS') || '';
      })(),
      category: extractCategoryValue(raw.fields?.[CATEGORY_FIELD]),
      scoring: normalizeScoring(raw.fields?.[SCORING_FIELD]),
    }));

    issues = issues.concat(pageIssues);
    nextPageToken = body.nextPageToken || undefined;
    guard += 1;
  } while (nextPageToken && guard < 20);

  return issues;
}

// Ejemplo: /api/jira/dashboard?month=2026-09  (si se omite, usa el mes actual)
app.get('/api/jira/dashboard', async (req, res) => {
  if (!JIRA_SITE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(500).json({ ok: false, error: 'Faltan variables de entorno de Jira en el servidor del proxy.' });
  }

  const month = req.query.month || currentMonthStr();

  try {
    const allIssues = [];
    for (const p of PROJECTS) {
      const issues = await fetchIssuesForMonth(p.code, month);
      for (const iss of issues) iss.projectName = p.name;
      allIssues.push(...issues);
    }

    const total = bloque(allIssues);
    const proyectos = groupBy(allIssues, (r) => r.projectName);
    const tecnicos = groupBy(allIssues, (r) => r.assignee || 'Sin asignar', (k) => isExcluded(k));
    const partners = partnersBreakdown(allIssues);
    const { categorias, familias, nCategorizadas } = categoryBreakdown(allIssues);
    const { locales, nConLocal } = localesBreakdown(allIssues);

    res.json({
      ok: true,
      month,
      n: allIssues.length,
      total,
      proyectos,
      tecnicos,
      partners,
      categorias,
      familias,
      nCategorizadas,
      locales,
      nConLocal,
    });
  } catch (err) {
    res.status(err.jiraStatus || 502).json({ ok: false, error: err.message, jiraBody: err.jiraBody });
  }
});

app.listen(PORT, () => {
  console.log(`\nProxy escuchando en http://localhost:${PORT}`);
  console.log(`Prueba en el navegador: http://localhost:${PORT}/api/jira/me\n`);
});
