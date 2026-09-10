// Diagnóstico AISLADO de la conexión a Jira: sin proxy, sin frontend, sin capas
// intermedias. Objetivo: saber EXACTAMENTE qué está fallando (credenciales,
// URL del site, CORS, red, permisos...) antes de construir nada encima.
//
// Uso:
//   1) cp .env.example .env   y rellena JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN
//   2) npm install
//   3) npm run test:jira

import 'dotenv/config';

const { JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

console.log('--- Diagnóstico de conexión a Jira ---\n');

if (!JIRA_SITE_URL) fail('Falta JIRA_SITE_URL en tu .env (ej: https://planetatim.atlassian.net)');
if (!JIRA_EMAIL) fail('Falta JIRA_EMAIL en tu .env');
if (!JIRA_API_TOKEN) fail('Falta JIRA_API_TOKEN en tu .env (genera uno nuevo en id.atlassian.com)');

let siteUrl;
try {
  siteUrl = new URL(JIRA_SITE_URL);
} catch {
  fail(`JIRA_SITE_URL no es una URL válida: "${JIRA_SITE_URL}"`);
}
if (!siteUrl.hostname.endsWith('.atlassian.net')) {
  console.warn(`⚠️  Aviso: "${siteUrl.hostname}" no termina en .atlassian.net — revisa que sea el dominio correcto de tu site.`);
}

const endpoint = `${siteUrl.origin}/rest/api/3/myself`;
const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

console.log(`Site:     ${siteUrl.origin}`);
console.log(`Usuario:  ${JIRA_EMAIL}`);
console.log(`Endpoint: ${endpoint}\n`);
console.log('Llamando a la API...\n');

try {
  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
  });

  const bodyText = await res.text();
  let body;
  try { body = JSON.parse(bodyText); } catch { body = bodyText; }

  console.log(`Status HTTP: ${res.status} ${res.statusText}`);

  const loginReason = res.headers.get('x-seraph-loginreason');
  const authReason = res.headers.get('x-authentication-denied-reason');
  if (loginReason) console.log(`Header X-Seraph-LoginReason: ${loginReason}`);
  if (authReason) console.log(`Header X-Authentication-Denied-Reason: ${authReason}`);

  if (res.status === 200) {
    console.log('\n✅ Conexión correcta. Jira respondió con éxito.\n');
    console.log(`Usuario autenticado: ${body.displayName} <${body.emailAddress}>`);
    console.log(`Account ID: ${body.accountId}`);
  } else if (res.status === 401) {
    console.error('\nCuerpo de la respuesta:', body);
    fail('401 Unauthorized — el email o el API token son incorrectos (o el token ha expirado/fue revocado). Genera uno nuevo en https://id.atlassian.com/manage-profile/security/api-tokens');
  } else if (res.status === 403) {
    console.error('\nCuerpo de la respuesta:', body);
    if (loginReason === 'AUTHENTICATED_FAILED' || authReason) {
      fail('403 con CAPTCHA/bloqueo de seguridad (X-Authentication-Denied-Reason) — Jira ha bloqueado temporalmente los intentos automáticos. Tienes que iniciar sesión manualmente por navegador en ' + siteUrl.origin + ' para resolver el CAPTCHA, y luego reintentar.');
    }
    fail('403 Forbidden — revisa: (1) que el email sea exactamente el de tu cuenta Atlassian, (2) que el token no tenga espacios de más al copiarlo, (3) los permisos/licencia del usuario en este site.');
  } else if (res.status === 404) {
    fail('404 Not Found — revisa JIRA_SITE_URL, puede que el dominio no sea correcto.');
  } else {
    console.error('\n❌ Respuesta inesperada:');
    console.error(body);
    process.exit(1);
  }
} catch (err) {
  console.error('\n❌ Fallo de RED (no llegó respuesta HTTP). Esto es lo que antes veíamos como "Failed to fetch".');
  console.error(`Tipo de error: ${err.name}`);
  console.error(`Mensaje: ${err.message}`);
  console.error('\nCausas típicas en este entorno:');
  console.error('  - El JIRA_SITE_URL está mal escrito o no resuelve (DNS)');
  console.error('  - Un firewall/proxy de red está bloqueando la salida a atlassian.net');
  console.error('  - Estás ejecutando esto desde un navegador (CORS) en vez de Node — este script corre en Node, así que CORS no debería aplicar aquí');
  process.exit(1);
}
