// ============================================================
// WORKER "flashtopup-proxy" — intermediario entre tu sitio y la
// API de FlashTopup.
//
// POR QUÉ EXISTE: tu sitio (XITERKING STORE) es HTML/JS puro, sin
// servidor propio. Si la clave secreta de FlashTopup (la "Clave
// API") estuviera en un archivo .js de tu sitio, cualquiera que
// abra el código fuente de la página se la podría llevar y hacer
// recargas gratis a tu costa. Este Worker vive aparte, en los
// servidores de Cloudflare, y es el ÚNICO lugar donde esa clave
// existe. Tu sitio le pide cosas a ESTE worker (con una clave
// propia tuya, mucho menos grave si se filtra) y el worker es
// quien realmente le habla a FlashTopup.
//
// ------------------------------------------------------------
// CÓMO DESPLEGAR ESTO (una sola vez, gratis)
// ------------------------------------------------------------
// 1. Andá a https://dash.cloudflare.com/ → creá una cuenta si no
//    tenés (gratis, no pide tarjeta para el plan free de Workers).
// 2. En el menú lateral: Workers & Pages → "Create" → "Create Worker".
//    Ponele un nombre, ej: "flashtopup-proxy". Deploy.
// 3. Click en "Edit code" (o "Quick edit") y pegá TODO este
//    archivo reemplazando lo que venga por defecto. Deploy.
// 4. En la página del Worker: Settings → Variables and Secrets →
//    "Add" y cargá estas 4, TODAS como tipo "Secret" (no "Text"):
//
//      FT_API_ID       -> tu "ID de API" de FlashTopup (RSECTHDQD7PALPE6)
//      FT_API_KEY      -> tu "Clave API" de FlashTopup (la larga)
//      SITE_KEY        -> inventate una clave random vos mismo,
//                          ej. una cadena larga random (no tiene que
//                          ver con FlashTopup, es solo para que tu
//                          web y el worker se reconozcan entre sí).
//                          Podés generar una acá: https://www.uuidgenerator.net/
//      ALLOWED_ORIGIN  -> el dominio de tu sitio, ej:
//                          https://xiterking-store.web.app
//                          (sin barra al final)
//
// 5. Copiá la URL que te da Cloudflare para tu Worker (algo como
//    https://flashtopup-proxy.tu-usuario.workers.dev) y pegala en
//    firebase-config.js en FLASHTOPUP_WORKER_URL. La SITE_KEY que
//    inventaste en el paso 4 también va en firebase-config.js en
//    FLASHTOPUP_SITE_KEY (tiene que ser IDÉNTICA en los dos lados).
//
// 6. Probá primero con X-FT-Sandbox activado (ver más abajo, es
//    automático si activás MODO_SANDBOX = true acá abajo) — así
//    podés probar el flujo completo SIN gastar saldo real de tu
//    billetera de FlashTopup ni hacer recargas de verdad.
// ============================================================

// Poné esto en true mientras probás, y en false cuando ya
// verificaste que las recargas reales funcionan bien.
const MODO_SANDBOX = true;

// IDs de servicio de FlashTopup para los paquetes de diamantes de
// Free Fire (los mismos que ves en tu panel de FlashTopup, pestaña
// "Productos y precios"). Si FlashTopup les cambia el ID en algún
// momento, se actualiza acá nomás.
const PAQUETES_FREE_FIRE = {
  542: 110,
  543: 341,
  544: 572,
  545: 1166,
  546: 2398,
  547: 6160,
};

// Código de "validación" del PRODUCTO Free Fire en FlashTopup (distinto
// de los serviceId de arriba, que son de cada PAQUETE de diamantes). Lo
// buscás en tu panel de FlashTopup, en la ficha del juego Free Fire —
// es el mismo tipo de código que en su doc de ejemplo usa "mlbb" para
// Mobile Legends. Reemplazá el texto de abajo por el tuyo.
const VALIDATION_CODE_FREE_FIRE = 'PONE_ACA_TU_CODIGO_DE_VALIDACION';

const FT_HOST = 'https://api.flashtopup.com';

// ---------- utilidades de firma HMAC-SHA256 (según la doc de FlashTopup) ----------

async function sha256Hex(texto) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(clave, mensaje) {
  const claveCrypto = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(clave),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const firma = await crypto.subtle.sign('HMAC', claveCrypto, new TextEncoder().encode(mensaje));
  return [...new Uint8Array(firma)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Llama a un endpoint de FlashTopup ya firmado correctamente.
// `path` tiene que ser la ruta CANÓNICA sin query string, ej:
// "/api/reseller/v2/order" (la doc de FlashTopup pide firmar
// siempre esta ruta completa, nunca un alias corto).
async function llamarFlashTopup(env, method, path, queryString, bodyObj) {
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  const bodyHash = await sha256Hex(bodyStr);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();

  const canonico = [method, path, timestamp, nonce, bodyHash].join('\n');
  const firma = await hmacSha256Hex(env.FT_API_KEY, canonico);

  const headers = {
    'X-FT-API-ID': env.FT_API_ID,
    'X-FT-Timestamp': timestamp,
    'X-FT-Nonce': nonce,
    'X-FT-Signature': firma,
  };
  if (bodyObj) headers['Content-Type'] = 'application/json';
  if (MODO_SANDBOX) headers['X-FT-Sandbox'] = 'true';

  const url = FT_HOST + path + (queryString ? '?' + queryString : '');
  const res = await fetch(url, {
    method,
    headers,
    body: bodyObj ? bodyStr : undefined,
  });

  let data;
  try { data = await res.json(); } catch (e) { data = null; }
  return { httpStatus: res.status, data };
}

// ---------- CORS + validación de que el pedido venga de tu propio sitio ----------

function headersCORS(origenPedido, env) {
  const permitido = origenPedido === env.ALLOWED_ORIGIN ? origenPedido : env.ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': permitido,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Site-Key',
    'Vary': 'Origin',
  };
}

function jsonResponse(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function siteKeyValida(request, env) {
  return request.headers.get('X-Site-Key') === env.SITE_KEY && !!env.SITE_KEY;
}

// ============================================================
// RUTAS QUE EXPONE ESTE WORKER (las que llama tu sitio)
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origenPedido = request.headers.get('Origin') || '';
    const cors = headersCORS(origenPedido, env);

    // preflight de CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, motivo: 'METODO_NO_PERMITIDO' }, 405, cors);
    }

    if (!siteKeyValida(request, env)) {
      return jsonResponse({ ok: false, motivo: 'NO_AUTORIZADO' }, 401, cors);
    }

    let body;
    try { body = await request.json(); } catch (e) {
      return jsonResponse({ ok: false, motivo: 'BODY_INVALIDO' }, 400, cors);
    }

    // ---------- POST /validar-uid ----------
    // body esperado: { uid: "123456789" }
    // Confirma que el UID de Free Fire existe ANTES de cobrar/crear la
    // orden, y devuelve el nombre de la cuenta para mostrárselo al
    // cliente (así puede confirmar que es la suya antes de recargar).
    if (url.pathname === '/validar-uid') {
      const { uid } = body;

      if (!uid || typeof uid !== 'string' || uid.trim().length < 3) {
        return jsonResponse({ ok: false, motivo: 'UID_INVALIDO' }, 400, cors);
      }

      const checkBody = {
        user_id: uid.trim(),
        // Free Fire no tiene server_id (a diferencia de otros juegos
        // como Mobile Legends), se manda vacío.
        server_id: '',
        validation_code: VALIDATION_CODE_FREE_FIRE,
      };

      const { httpStatus, data } = await llamarFlashTopup(
        env, 'POST', '/api/reseller/v2/check-id', null, checkBody
      );

      if (!data) {
        return jsonResponse({ ok: false, motivo: 'RESPUESTA_INVALIDA_DE_FLASHTOPUP' }, 502, cors);
      }
      if (!data.exito) {
        return jsonResponse({
          ok: false,
          motivo: data.error?.codigo || 'ERROR_DESCONOCIDO',
          mensaje: data.error?.mensaje || '',
        }, httpStatus, cors);
      }

      const datos = data.datos || {};
      return jsonResponse({
        ok: true,
        valido: datos['válido'] !== false,
        nombreCuenta: datos['nombre_de_cuenta'] || '',
      }, 200, cors);
    }

    // ---------- POST /crear-orden ----------
    // body esperado: { serviceId: 542, uid: "123456789", referenceId: "uuid-unico" }
    if (url.pathname === '/crear-orden') {
      const { serviceId, uid, referenceId } = body;

      if (!PAQUETES_FREE_FIRE[serviceId]) {
        return jsonResponse({ ok: false, motivo: 'PAQUETE_DESCONOCIDO' }, 400, cors);
      }
      if (!uid || typeof uid !== 'string' || uid.trim().length < 3) {
        return jsonResponse({ ok: false, motivo: 'UID_INVALIDO' }, 400, cors);
      }
      if (!referenceId || typeof referenceId !== 'string') {
        return jsonResponse({ ok: false, motivo: 'REFERENCE_ID_FALTANTE' }, 400, cors);
      }

      const ordenBody = {
        service_code: serviceId.toString(),
        reference_id: referenceId,
        cantidad: 1,
        user_id: uid.trim(),
        // Nota: Free Fire solo pide el UID del jugador (a diferencia de
        // juegos como Mobile Legends que también piden server_id). Si
        // FlashTopup devuelve VALIDACION_FALLIDA pidiendo un campo
        // extra, el error trae el nombre exacto del campo que falta
        // (ver el "motivo"/"errores" que devuelve este mismo endpoint)
        // y se agrega acá.
      };

      const { httpStatus, data } = await llamarFlashTopup(
        env, 'POST', '/api/reseller/v2/order', null, ordenBody
      );

      if (!data) {
        return jsonResponse({ ok: false, motivo: 'RESPUESTA_INVALIDA_DE_FLASHTOPUP' }, 502, cors);
      }
      if (!data.exito) {
        return jsonResponse({
          ok: false,
          motivo: data.error?.codigo || 'ERROR_DESCONOCIDO',
          mensaje: data.error?.mensaje || '',
          detalle: data.error || null,
        }, httpStatus, cors);
      }

      return jsonResponse({
        ok: true,
        orderId: data.datos.order_id,
        estado: data.datos.estado || data.datos.order_status,
        diamantes: PAQUETES_FREE_FIRE[serviceId],
      }, 200, cors);
    }

    // ---------- POST /consultar-orden ----------
    // body esperado: { orderId: "ORD1" }  ó  { referenceId: "uuid-unico" }
    if (url.pathname === '/consultar-orden') {
      const { orderId, referenceId } = body;
      if (!orderId && !referenceId) {
        return jsonResponse({ ok: false, motivo: 'FALTA_ORDER_ID_O_REFERENCE_ID' }, 400, cors);
      }

      const qs = orderId
        ? 'order_id=' + encodeURIComponent(orderId)
        : 'reference_id=' + encodeURIComponent(referenceId);

      const { httpStatus, data } = await llamarFlashTopup(
        env, 'GET', '/api/reseller/v2/order/status', qs, null
      );

      if (!data) {
        return jsonResponse({ ok: false, motivo: 'RESPUESTA_INVALIDA_DE_FLASHTOPUP' }, 502, cors);
      }
      if (!data.exito) {
        return jsonResponse({
          ok: false,
          motivo: data.error?.codigo || 'ERROR_DESCONOCIDO',
          mensaje: data.error?.mensaje || '',
        }, httpStatus, cors);
      }

      return jsonResponse({
        ok: true,
        orderId: data.datos.order_id,
        estado: data.datos.estado || data.datos.order_status,
        nota: data.datos.nota || '',
      }, 200, cors);
    }

    return jsonResponse({ ok: false, motivo: 'RUTA_NO_ENCONTRADA' }, 404, cors);
  },
};
