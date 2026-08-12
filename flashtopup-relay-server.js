// ============================================================
// RELAY DE FLASHTOPUP — CON IP FIJA
// ------------------------------------------------------------
// POR QUÉ EXISTE ESTE ARCHIVO: FlashTopup te devuelve el error
// "IP_NOT_ALLOWED" porque su API solo acepta pedidos desde una IP
// que vos whitelisteaste en su panel. El problema es que el Worker
// de Cloudflare (flashtopup-proxy / index.js) NO tiene una IP fija:
// cada pedido puede salir por una IP distinta, así que whitelistear
// una sola nunca funciona de forma confiable.
//
// LA SOLUCIÓN: este archivo es EXACTAMENTE la misma lógica que ya
// tenías en el Worker (index.js), pero para correr en una VPS
// (servidor propio) que sí tiene una IP fija de verdad. Ahora el
// flujo completo queda así:
//
//   Tu web (navegador)  →  ESTE SERVIDOR (IP fija)  →  FlashTopup
//
// Y en el panel de FlashTopup whitelisteás la IP de TU VPS, que
// nunca cambia.
//
// No usa ninguna librería externa (ni Express, ni nada) — solo
// Node.js "de fábrica" — así no hace falta correr "npm install"
// en el servidor, alcanza con tener Node instalado.
//
// ------------------------------------------------------------
// CÓMO DESPLEGAR ESTO (una sola vez)
// ------------------------------------------------------------
// 1. CONSEGUÍ UNA VPS CON IP FIJA
//    Cualquiera de estas sirve (Ubuntu 22.04, la más chica alcanza):
//      - Oracle Cloud "Free Tier" → gratis para siempre, pide
//        tarjeta solo para verificar identidad, no cobra nada en
//        el plan gratuito. https://www.oracle.com/cloud/free/
//      - DigitalOcean → droplet más chico, ~6 USD/mes.
//        https://www.digitalocean.com/
//      - Contabo, Hetzner, Vultr → alternativas similares y baratas.
//    Cuando la crees, anotá la IP pública que te dan (ej: 45.55.123.45)
//    — ESA es la que vas a whitelistear en FlashTopup más adelante.
//
// 2. INSTALÁ NODE.JS EN LA VPS
//    Conectate por SSH (el proveedor te explica cómo, generalmente
//    con una consola web o con "ssh root@tu-ip") y corré:
//      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
//      sudo apt-get install -y nodejs
//
// 3. SUBÍ ESTE ARCHIVO A LA VPS
//    La forma más simple: creá un archivo nuevo en la VPS con
//      nano flashtopup-relay-server.js
//    y pegás TODO el contenido de este archivo ahí (Ctrl+O para
//    guardar, Ctrl+X para salir).
//
// 4. CREÁ EL ARCHIVO DE VARIABLES (.env) AL LADO
//    En la misma carpeta, corré:
//      nano .env
//    y pegá esto, reemplazando cada valor por el tuyo real
//    (los mismos que ya usabas en el Worker de Cloudflare):
//
//      FT_API_ID=RSECTHDQD7PALPE6
//      FT_API_KEY=tu-clave-api-larga-de-flashtopup
//      SITE_KEY=la-misma-site-key-que-ya-usás-en-firebase-config.js
//      ALLOWED_ORIGIN=https://xiterking-store.web.app
//      PORT=8787
//
//    Guardá con Ctrl+O, salí con Ctrl+X.
//
// 5. PROBALO UNA VEZ A MANO
//      cd /la/carpeta/donde/está/todo
//      node --env-file=.env flashtopup-relay-server.js
//    Tiene que imprimir algo como "Relay de FlashTopup escuchando
//    en el puerto 8787". Dejalo corriendo un segundo y Ctrl+C.
//
// 6. HACÉ QUE QUEDE CORRIENDO SIEMPRE (aunque reinicies la VPS)
//    La forma más simple es con "pm2" (un administrador de
//    procesos para Node):
//      sudo npm install -g pm2
//      pm2 start flashtopup-relay-server.js --name flashtopup-relay
//      pm2 startup
//      pm2 save
//    (El comando "pm2 startup" te va a mostrar OTRO comando para
//    copiar y pegar — hacelo, es lo que hace que arranque solo si
//    se reinicia el servidor.)
//
// 7. PONELE HTTPS (obligatorio — tu web es https, así que este
//    servidor también tiene que serlo, si no el navegador bloquea
//    el pedido). La forma más fácil es con "Caddy", que consigue el
//    certificado solo y gratis:
//      a) Necesitás un dominio o subdominio propio apuntando a la
//         IP de tu VPS (ej: flashtopup-relay.tudominio.com → tu IP,
//         con un registro DNS tipo "A"). Si no tenés dominio,
//         comprá uno barato (Namecheap, etc.) — no hace falta que
//         sea el mismo del sitio.
//      b) Instalá Caddy: https://caddyserver.com/docs/install
//      c) Creá un archivo /etc/caddy/Caddyfile con:
//
//           flashtopup-relay.tudominio.com {
//             reverse_proxy localhost:8787
//           }
//
//      d) sudo systemctl restart caddy
//    Caddy se encarga de conseguir el certificado HTTPS solo (usa
//    Let's Encrypt) y de renovarlo automáticamente.
//
// 8. ACTUALIZÁ TU SITIO
//    En firebase-config.js, cambiá:
//      FLASHTOPUP_WORKER_URL de la URL vieja de Cloudflare Workers
//      a: "https://flashtopup-relay.tudominio.com"
//    (FLASHTOPUP_SITE_KEY se queda igual — tiene que ser IDÉNTICA
//    a la SITE_KEY que pusiste en el .env de la VPS.)
//
// 9. WHITELISTEÁ LA IP EN FLASHTOPUP
//    Panel de FlashTopup → Tools → Profile Settings → API →
//    "Whitelist IP addresses" → pegá la IP pública de tu VPS
//    (la del paso 1) → guardar.
//
// 10. PROBÁ UNA RECARGA DE VERDAD. Si algo falla, mirá los logs con:
//       pm2 logs flashtopup-relay
// ============================================================

const http = require('node:http');
const crypto = require('node:crypto');

const FT_API_ID = process.env.FT_API_ID;
const FT_API_KEY = process.env.FT_API_KEY;
const SITE_KEY = process.env.SITE_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
const PORT = Number(process.env.PORT || 8787);

if (!FT_API_ID || !FT_API_KEY || !SITE_KEY || !ALLOWED_ORIGIN) {
  console.error('Faltan variables de entorno. Revisá tu archivo .env (FT_API_ID, FT_API_KEY, SITE_KEY, ALLOWED_ORIGIN).');
  process.exit(1);
}

// Poné esto en true mientras probás, y en false cuando ya
// verificaste que las recargas reales funcionan bien (igual que en
// el Worker viejo).
const MODO_SANDBOX = true;

// Mismos paquetes que tenías en el Worker — si agregás/cambiás
// paquetes ahí, actualizá también acá.
const PAQUETES_FREE_FIRE = {
  542: { diamantes: 110, code: 'TOPUP_FREE_FIRE_LATAM_15_110_DIAMONDS_542' },
  543: { diamantes: 341, code: 'TOPUP_FREE_FIRE_LATAM_15_341_DIAMONDS_543' },
  544: { diamantes: 572, code: 'TOPUP_FREE_FIRE_LATAM_15_572_DIAMONDS_544' },
  545: { diamantes: 1166, code: 'TOPUP_FREE_FIRE_LATAM_15_1166_DIAMONDS_545' },
  546: { diamantes: 2398, code: 'TOPUP_FREE_FIRE_LATAM_15_2398_DIAMONDS_546' },
  547: { diamantes: 6160, code: 'TOPUP_FREE_FIRE_LATAM_15_6160_DIAMONDS_547' },
};

const VALIDATION_CODE_FREE_FIRE = 'freefire_latam';
const PRODUCT_CODE_FREE_FIRE = 'TOPUP_FREE_FIRE_LATAM_15';
const FT_HOST = 'https://api.flashtopup.com';

// ---------- firma HMAC-SHA256 (misma doc de FlashTopup, ahora con crypto de Node) ----------

function sha256Hex(texto) {
  return crypto.createHash('sha256').update(texto).digest('hex');
}

function hmacSha256Hex(clave, mensaje) {
  return crypto.createHmac('sha256', clave).update(mensaje).digest('hex');
}

async function llamarFlashTopup(method, path, queryString, bodyObj) {
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  const bodyHash = sha256Hex(bodyStr);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();

  const canonico = [method, path, timestamp, nonce, bodyHash].join('\n');
  const firma = hmacSha256Hex(FT_API_KEY, canonico);

  const headers = {
    'X-FT-API-ID': FT_API_ID,
    'X-FT-Timestamp': timestamp,
    'X-FT-Nonce': nonce,
    'X-FT-Signature': firma,
  };
  if (bodyObj) headers['Content-Type'] = 'application/json';
  if (MODO_SANDBOX) headers['X-FT-Sandbox'] = 'true';

  const url = FT_HOST + path + (queryString ? '?' + queryString : '');
  const res = await fetch(url, { method, headers, body: bodyObj ? bodyStr : undefined });

  let data;
  try { data = await res.json(); } catch (e) { data = null; }
  return { httpStatus: res.status, data };
}

// ---------- utilidades HTTP ----------

function headersCORS() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Site-Key',
    'Vary': 'Origin',
  };
}

function enviarJson(res, status, obj) {
  const cors = headersCORS();
  res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
  res.end(JSON.stringify(obj));
}

function siteKeyValida(req) {
  return req.headers['x-site-key'] === SITE_KEY;
}

function leerBodyJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
    });
  });
}

// ============================================================
// SERVIDOR
// ============================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headersCORS());
    return res.end();
  }

  // ---------- GET /debug-servicios (diagnóstico, protegido) ----------
  if (req.method === 'GET' && url.pathname === '/debug-servicios') {
    if (!siteKeyValida(req)) return enviarJson(res, 401, { ok: false, motivo: 'NO_AUTORIZADO' });

    const { httpStatus, data } = await llamarFlashTopup(
      'GET', '/api/reseller/v2/services', 'product_code=' + encodeURIComponent(PRODUCT_CODE_FREE_FIRE), null
    );
    return enviarJson(res, 200, { ok: true, modoSandbox: MODO_SANDBOX, httpStatusDeFlashTopup: httpStatus, respuestaCompleta: data });
  }

  if (req.method !== 'POST') {
    return enviarJson(res, 405, { ok: false, motivo: 'METODO_NO_PERMITIDO' });
  }

  if (!siteKeyValida(req)) {
    return enviarJson(res, 401, { ok: false, motivo: 'NO_AUTORIZADO' });
  }

  const body = await leerBodyJson(req);
  if (body === null) {
    return enviarJson(res, 400, { ok: false, motivo: 'BODY_INVALIDO' });
  }

  // ---------- POST /validar-uid ----------
  if (url.pathname === '/validar-uid') {
    const { uid } = body;
    if (!uid || typeof uid !== 'string' || uid.trim().length < 3) {
      return enviarJson(res, 400, { ok: false, motivo: 'UID_INVALIDO' });
    }

    const checkBody = {
      user_id: uid.trim(),
      product_code: PRODUCT_CODE_FREE_FIRE,
      validation_code: VALIDATION_CODE_FREE_FIRE,
    };

    const { httpStatus, data } = await llamarFlashTopup('POST', '/api/reseller/v2/check-id', null, checkBody);

    if (!data) return enviarJson(res, 502, { ok: false, motivo: 'RESPUESTA_INVALIDA_DE_FLASHTOPUP' });
    if (!data.success) {
      return enviarJson(res, httpStatus, { ok: false, motivo: data.error?.code || 'ERROR_DESCONOCIDO', mensaje: data.error?.message || '' });
    }

    const datos = data.data || {};
    return enviarJson(res, 200, {
      ok: true,
      valido: (datos.valid ?? datos['válido']) !== false,
      nombreCuenta: datos.account_name || datos['nombre_de_cuenta'] || datos.username || '',
    });
  }

  // ---------- POST /crear-orden ----------
  if (url.pathname === '/crear-orden') {
    const { serviceId, uid, referenceId } = body;

    if (!PAQUETES_FREE_FIRE[serviceId]) return enviarJson(res, 400, { ok: false, motivo: 'PAQUETE_DESCONOCIDO' });
    if (!uid || typeof uid !== 'string' || uid.trim().length < 3) return enviarJson(res, 400, { ok: false, motivo: 'UID_INVALIDO' });
    if (!referenceId || typeof referenceId !== 'string') return enviarJson(res, 400, { ok: false, motivo: 'REFERENCE_ID_FALTANTE' });

    const ordenBody = {
      service_code: PAQUETES_FREE_FIRE[serviceId].code,
      reference_id: referenceId,
      cantidad: 1,
      user_id: uid.trim(),
    };

    const { httpStatus, data } = await llamarFlashTopup('POST', '/api/reseller/v2/order', null, ordenBody);

    if (!data) return enviarJson(res, 502, { ok: false, motivo: 'RESPUESTA_INVALIDA_DE_FLASHTOPUP' });
    if (!data.success) {
      return enviarJson(res, httpStatus, {
        ok: false,
        motivo: data.error?.code || 'ERROR_DESCONOCIDO',
        mensaje: data.error?.message || '',
        detalle: data.error || null,
        bodyEnviado: ordenBody,
      });
    }

    const datosOrden = data.data || {};
    return enviarJson(res, 200, {
      ok: true,
      orderId: datosOrden.order_id ?? datosOrden.orderId,
      estado: datosOrden.status ?? datosOrden.estado ?? datosOrden.order_status,
      diamantes: PAQUETES_FREE_FIRE[serviceId].diamantes,
    });
  }

  // ---------- POST /consultar-orden ----------
  if (url.pathname === '/consultar-orden') {
    const { orderId, referenceId } = body;
    if (!orderId && !referenceId) return enviarJson(res, 400, { ok: false, motivo: 'FALTA_ORDER_ID_O_REFERENCE_ID' });

    const qs = orderId ? 'order_id=' + encodeURIComponent(orderId) : 'reference_id=' + encodeURIComponent(referenceId);
    const { httpStatus, data } = await llamarFlashTopup('GET', '/api/reseller/v2/order/status', qs, null);

    if (!data) return enviarJson(res, 502, { ok: false, motivo: 'RESPUESTA_INVALIDA_DE_FLASHTOPUP' });
    if (!data.success) {
      return enviarJson(res, httpStatus, { ok: false, motivo: data.error?.code || 'ERROR_DESCONOCIDO', mensaje: data.error?.message || '' });
    }

    const datosConsulta = data.data || {};
    return enviarJson(res, 200, {
      ok: true,
      orderId: datosConsulta.order_id ?? datosConsulta.orderId,
      estado: datosConsulta.status ?? datosConsulta.estado ?? datosConsulta.order_status,
      nota: datosConsulta.note ?? datosConsulta.nota ?? '',
    });
  }

  return enviarJson(res, 404, { ok: false, motivo: 'RUTA_NO_ENCONTRADA' });
});

server.listen(PORT, () => {
  console.log(`Relay de FlashTopup escuchando en el puerto ${PORT} (modo sandbox: ${MODO_SANDBOX})`);
});
