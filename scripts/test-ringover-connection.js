// Diagnóstico AISLADO de la conexión a Ringover: mismo enfoque que el de Jira,
// sin proxy ni frontend de por medio.
//
// Uso:
//   1) En tu .env añade RINGOVER_API_KEY (Dashboard de Ringover > Developer > API key)
//   2) npm run test:ringover

import 'dotenv/config';

const { RINGOVER_API_KEY } = process.env;

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

console.log('--- Diagnóstico de conexión a Ringover ---\n');

if (!RINGOVER_API_KEY) fail('Falta RINGOVER_API_KEY en tu .env. Genera una en: Dashboard de Ringover > Developer > API key');

const BASE_URL = 'https://public-api.ringover.com/v2';

// Ventana corta (últimas 24h) y limit_count bajo: solo queremos confirmar que
// la clave funciona, no traer datos todavía.
const end = new Date();
const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
const params = new URLSearchParams({
  limit_count: '1',
  start_date: start.toISOString().slice(0, 19),
  end_date: end.toISOString().slice(0, 19),
});

const endpoint = `${BASE_URL}/calls?${params.toString()}`;

console.log(`Endpoint: ${endpoint}\n`);
console.log('Llamando a la API...\n');

try {
  const res = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: RINGOVER_API_KEY,
      Accept: 'application/json',
    },
  });

  const bodyText = await res.text();
  let body;
  try { body = JSON.parse(bodyText); } catch { body = bodyText; }

  console.log(`Status HTTP: ${res.status} ${res.statusText}`);
  console.log('\nCuerpo de la respuesta:');
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));

  if (res.status === 200) {
    console.log('\n✅ Conexión correcta. Ringover respondió con éxito.\n');
  } else if (res.status === 401 || res.status === 403) {
    fail(`${res.status} — la API key es inválida, fue revocada, o no tiene permisos. Genera una nueva en el Dashboard de Ringover > Developer > API key.`);
  } else if (res.status === 400 || res.status === 422) {
    console.error('\n⚠️  La clave puede ser válida, pero los parámetros de esta llamada de prueba no son los que la API espera (ver cuerpo de la respuesta arriba). Compárteme este mensaje para ajustar los parámetros.');
    process.exit(1);
  } else {
    process.exit(1);
  }
} catch (err) {
  console.error('\n❌ Fallo de red (no llegó respuesta HTTP).');
  console.error(`Tipo de error: ${err.name}`);
  console.error(`Mensaje: ${err.message}`);
  process.exit(1);
}
