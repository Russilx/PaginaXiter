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
// (servidor propio) que sí tiene una IP fija de verdad.
//
// NOVEDAD: se agregaron acá mismo las rutas /saldo/* de la cuenta
// con saldo (xiterking-saldo.html + xiterking-saldo-admin.html).
// Usan Firebase Admin SDK, así que esta vez SÍ hace falta
// "npm install firebase-admin" (el resto del archivo sigue sin
// depender de ninguna librería externa).
// ============================================================

const http = require('node:http');
const crypto = require('node:crypto');
const admin = require('firebase-admin');

const FT_API_ID = process.env.FT_API_ID;
const FT_API_KEY = process.env.FT_API_KEY;
const SITE_KEY = process.env.SITE_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
const PORT = Number(process.env.PORT || 8787);

if (!FT_API_ID || !FT_API_KEY || !SITE_KEY || !ALLOWED_ORIGIN) {
  console.error('Faltan variables de entorno. Revisá tu archivo .env (FT_API_ID, FT_API_KEY, SITE_KEY, ALLOWED_ORIGIN).');
  process.exit(1);
}

// Secreto para que el worker de Mercado Pago pueda acreditar saldo,
// y clave de admin para el panel (aprobar/rechazar cargas, ajustar
// saldo a mano, etc.). Ponelas en el mismo .env que ya tenés.
const MP_SHARED_SECRET = process.env.MP_SHARED_SECRET || 'XITERKINGELMEJOR';
const ADMIN_KEY = process.env.ADMIN_KEY || 'REEMPLAZAR-otra-clave-larga';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require('./serviceAccountKey.json'))
  });
}
const db = admin.firestore();

// Poné esto en true mientras probás, y en false cuando ya
// verificaste que las recargas reales funcionan bien (igual que en
// el Worker viejo).
const MODO_SANDBOX = false;

// Mismos paquetes que tenías en el Worker — si agregás/cambiás
// paquetes ahí, actualizá también acá.
const PAQUETES_FREE_FIRE = {
  542: { diamantes: 110, code: 'TOPUP_FREE_FIRE_LATAM_110_DIAMONDS_542' },
  543: { diamantes: 341, code: 'TOPUP_FREE_FIRE_LATAM_341_DIAMONDS_543' },
  544: { diamantes: 572, code: 'TOPUP_FREE_FIRE_LATAM_572_DIAMONDS_544' },
  545: { diamantes: 1166, code: 'TOPUP_FREE_FIRE_LATAM_1166_DIAMONDS_545' },
  546: { diamantes: 2398, code: 'TOPUP_FREE_FIRE_LATAM_2398_DIAMONDS_546' },
  547: { diamantes: 6160, code: 'TOPUP_FREE_FIRE_LATAM_6160_DIAMONDS_547' },
};

// Precio en USDT de cada paquete, para descontar del saldo. Mismos
// valores que ya tenés en xiterking-saldo.html — si cambiás uno,
// cambialo en los dos lugares.
const PRECIOS_SALDO = {
  542: 0.77, 543: 2.32, 544: 3.93, 545: 7.29, 546: 14.48, 547: 36.84,
};

const VALIDATION_CODE_FREE_FIRE = 'freefire_latam';
const PRODUCT_CODE_FREE_FIRE = 'TOPUP_FREE_FIRE_LATAM';
const FT_HOST = 'https://api.flashtopup.com';

// ---------- firma HMAC-SHA256 ----------

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

// Ejecuta la compra real contra FlashTopup — misma lógica que
// /crear-orden, pero como función reutilizable para /saldo/comprar.
async function ejecutarRecargaFlashTopup(uidFF, packageId) {
  const paquete = PAQUETES_FREE_FIRE[packageId];
  if (!paquete) throw new Error('PAQUETE_DESCONOCIDO');

  const ordenBody = {
    service_code: paquete.code,
    reference_id: crypto.randomUUID(),
    cantidad: 1,
    user_id: uidFF.trim(),
  };

  const { data } = await llamarFlashTopup('POST', '/api/reseller/v2/order', null, ordenBody);
  if (!data) throw new Error('RESPUESTA_INVALIDA_DE_FLASHTOPUP');
  if (!data.success) throw new Error(data.error?.message || data.error?.code || 'FLASHTOPUP_RECHAZO_LA_ORDEN');

  const datosOrden = data.data || {};
  return {
    orderId: datosOrden.order_id ?? datosOrden.orderId,
    estado: datosOrden.status ?? datosOrden.estado ?? datosOrden.order_status,
  };
}

// ---------- utilidades HTTP ----------

function headersCORS(req) {
  return {
    'Access-Control-Allow-Origin': (ALLOWED_ORIGIN.split(',').map(o => o.trim()).includes(req.headers['origin']) ? req.headers['origin'] : ALLOWED_ORIGIN.split(',')[0].trim()),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Site-Key, X-Admin-Key, Authorization, X-MP-Secret',
    'Vary': 'Origin',
  };
}

function enviarJson(req, res, status, obj) {
  const cors = headersCORS(req);
  res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
  res.end(JSON.stringify(obj));
}

function siteKeyValida(req) {
  return req.headers['x-site-key'] === SITE_KEY;
}

function adminKeyValida(req) {
  return req.headers['x-admin-key'] === ADMIN_KEY;
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

async function uidDesdeIdToken(req) {
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.uid;
  } catch (e) {
    return null;
  }
}

// ============================================================
// RUTAS DE SALDO (/saldo/...) — cuenta con saldo
// ============================================================

async function manejarRutaSaldo(req, res, url) {
  const pathname = url.pathname;

  // ---------- POST /saldo/comprar ----------
  if (req.method === 'POST' && pathname === '/saldo/comprar') {
    const uid = await uidDesdeIdToken(req);
    if (!uid) return enviarJson(req, res, 401, { ok: false, mensaje: 'Sesión inválida o vencida.' });

    const body = await leerBodyJson(req);
    if (body === null) return enviarJson(req, res, 400, { ok: false, mensaje: 'Body inválido.' });

    const { uidFF, packageId } = body;
    const precio = PRECIOS_SALDO[packageId];
    if (!uidFF || !precio) return enviarJson(req, res, 400, { ok: false, mensaje: 'Datos de compra inválidos.' });

    const userRef = db.collection('saldo_usuarios').doc(uid);
    const movRef = db.collection('saldo_movimientos').doc();

    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const saldoActual = snap.exists ? (snap.data().saldo || 0) : 0;
        if (saldoActual < precio) throw new Error('SALDO_INSUFICIENTE');
        tx.update(userRef, { saldo: admin.firestore.FieldValue.increment(-precio) });
        tx.set(movRef, {
          usuarioUid: uid, tipo: 'compra', monto: precio,
          diamantes: PAQUETES_FREE_FIRE[packageId]?.diamantes || 0,
          uidFF, packageId, estado: 'procesando', fecha: Date.now()
        });
      });
    } catch (e) {
      if (e.message === 'SALDO_INSUFICIENTE') return enviarJson(req, res, 400, { ok: false, mensaje: 'Saldo insuficiente.' });
      return enviarJson(req, res, 500, { ok: false, mensaje: 'No se pudo procesar el débito.' });
    }

    try {
      const resultado = await ejecutarRecargaFlashTopup(uidFF, packageId);
      await movRef.update({ estado: 'completado', orderId: resultado.orderId || null });
      return enviarJson(req, res, 200, { ok: true, diamantes: PAQUETES_FREE_FIRE[packageId].diamantes });
    } catch (e) {
      await db.runTransaction(async (tx) => {
        tx.update(userRef, { saldo: admin.firestore.FieldValue.increment(precio) });
        tx.update(movRef, { estado: 'fallido', error: String(e.message || e) });
      });
      return enviarJson(req, res, 502, { ok: false, mensaje: 'FlashTopup no pudo procesar la recarga. Se devolvió tu saldo.' });
    }
  }

  // ---------- POST /saldo/acreditar-mp ----------
  if (req.method === 'POST' && pathname === '/saldo/acreditar-mp') {
    if (req.headers['x-mp-secret'] !== MP_SHARED_SECRET) return enviarJson(req, res, 403, { ok: false, mensaje: 'No autorizado.' });

    const body = await leerBodyJson(req);
    if (body === null) return enviarJson(req, res, 400, { ok: false, mensaje: 'Body inválido.' });
    const { usuarioUid, monto, referenciaPago } = body;
    if (!usuarioUid || !monto || monto <= 0) return enviarJson(req, res, 400, { ok: false, mensaje: 'Datos inválidos.' });

    const userRef = db.collection('saldo_usuarios').doc(usuarioUid);
    const movRef = db.collection('saldo_movimientos').doc();
    await db.runTransaction(async (tx) => {
      tx.update(userRef, { saldo: admin.firestore.FieldValue.increment(monto) });
      tx.set(movRef, {
        usuarioUid, tipo: 'carga', metodo: 'mercadopago', monto,
        referencia: referenciaPago || '', estado: 'completado', fecha: Date.now()
      });
    });
    return enviarJson(req, res, 200, { ok: true });
  }

  // A partir de acá, todas las rutas son de administración: piden X-Admin-Key.
  if (!adminKeyValida(req)) {
    return enviarJson(req, res, 403, { ok: false, mensaje: 'No autorizado.' });
  }

  // ---------- GET /saldo/admin/pendientes ----------
  if (req.method === 'GET' && pathname === '/saldo/admin/pendientes') {
    try {
      const snap = await db.collection('saldo_movimientos')
        .where('tipo', '==', 'carga')
        .where('estado', '==', 'pendiente')
        .orderBy('fecha', 'asc')
        .get();

      const pendientes = await Promise.all(snap.docs.map(async (d) => {
        const mov = d.data();
        const uSnap = await db.collection('saldo_usuarios').doc(mov.usuarioUid).get();
        return { id: d.id, ...mov, email: uSnap.exists ? (uSnap.data().email || '') : '' };
      }));
      return enviarJson(req, res, 200, { ok: true, pendientes });
    } catch (e) {
      return enviarJson(req, res, 500, { ok: false, mensaje: 'No se pudo obtener la lista.' });
    }
  }

  // ---------- GET /saldo/admin/usuario?uid=...|email=... ----------
  if (req.method === 'GET' && pathname === '/saldo/admin/usuario') {
    try {
      let uid = url.searchParams.get('uid');
      const email = url.searchParams.get('email');

      if (!uid && email) {
        const q = await db.collection('saldo_usuarios').where('email', '==', email).limit(1).get();
        if (q.empty) return enviarJson(req, res, 404, { ok: false, mensaje: 'No se encontró ningún usuario con ese email.' });
        uid = q.docs[0].id;
      }
      if (!uid) return enviarJson(req, res, 400, { ok: false, mensaje: 'Falta uid o email.' });

      const uSnap = await db.collection('saldo_usuarios').doc(uid).get();
      if (!uSnap.exists) return enviarJson(req, res, 404, { ok: false, mensaje: 'No se encontró ese usuario.' });

      const movSnap = await db.collection('saldo_movimientos')
        .where('usuarioUid', '==', uid).orderBy('fecha', 'desc').limit(30).get();

      return enviarJson(req, res, 200, {
        ok: true, uid, usuario: uSnap.data(),
        movimientos: movSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      });
    } catch (e) {
      return enviarJson(req, res, 500, { ok: false, mensaje: 'No se pudo cargar ese usuario.' });
    }
  }

  // ---------- GET /saldo/admin/movimientos-recientes?limit=50 ----------
  if (req.method === 'GET' && pathname === '/saldo/admin/movimientos-recientes') {
    try {
      const limite = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      const snap = await db.collection('saldo_movimientos').orderBy('fecha', 'desc').limit(limite).get();
      const uids = [...new Set(snap.docs.map(d => d.data().usuarioUid))];
      const emailsPorUid = {};
      await Promise.all(uids.map(async (uid) => {
        const uSnap = await db.collection('saldo_usuarios').doc(uid).get();
        emailsPorUid[uid] = uSnap.exists ? (uSnap.data().email || '') : '';
      }));
      const movimientos = snap.docs.map(d => ({ id: d.id, ...d.data(), email: emailsPorUid[d.data().usuarioUid] || '' }));
      return enviarJson(req, res, 200, { ok: true, movimientos });
    } catch (e) {
      return enviarJson(req, res, 500, { ok: false, mensaje: 'No se pudo cargar la actividad reciente.' });
    }
  }

  // ---------- POST /saldo/aprobar-carga ----------
  if (req.method === 'POST' && pathname === '/saldo/aprobar-carga') {
    const body = await leerBodyJson(req);
    if (body === null) return enviarJson(req, res, 400, { ok: false, mensaje: 'Body inválido.' });
    const { movimientoId } = body;
    const movRef = db.collection('saldo_movimientos').doc(movimientoId);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(movRef);
        if (!snap.exists) throw new Error('NO_EXISTE');
        const mov = snap.data();
        if (mov.estado !== 'pendiente') throw new Error('YA_PROCESADA');
        const userRef = db.collection('saldo_usuarios').doc(mov.usuarioUid);
        tx.update(userRef, { saldo: admin.firestore.FieldValue.increment(mov.monto) });
        tx.update(movRef, { estado: 'aprobado' });
      });
      return enviarJson(req, res, 200, { ok: true });
    } catch (e) {
      return enviarJson(req, res, 400, { ok: false, mensaje: e.message === 'YA_PROCESADA' ? 'Esa carga ya fue procesada.' : 'No se encontró la carga.' });
    }
  }

  // ---------- POST /saldo/rechazar-carga ----------
  if (req.method === 'POST' && pathname === '/saldo/rechazar-carga') {
    const body = await leerBodyJson(req);
    if (body === null) return enviarJson(req, res, 400, { ok: false, mensaje: 'Body inválido.' });
    const { movimientoId, motivo } = body;
    const movRef = db.collection('saldo_movimientos').doc(movimientoId);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(movRef);
        if (!snap.exists) throw new Error('NO_EXISTE');
        const mov = snap.data();
        if (mov.estado !== 'pendiente') throw new Error('YA_PROCESADA');
        tx.update(movRef, { estado: 'rechazado', motivoRechazo: motivo || '' });
      });
      return enviarJson(req, res, 200, { ok: true });
    } catch (e) {
      return enviarJson(req, res, 400, { ok: false, mensaje: e.message === 'YA_PROCESADA' ? 'Esa carga ya fue procesada.' : 'No se encontró la carga.' });
    }
  }

  // ---------- POST /saldo/admin/ajustar-saldo ----------
  if (req.method === 'POST' && pathname === '/saldo/admin/ajustar-saldo') {
    const body = await leerBodyJson(req);
    if (body === null) return enviarJson(req, res, 400, { ok: false, mensaje: 'Body inválido.' });
    const { uid, monto, motivo } = body;
    const montoNum = Number(monto);
    if (!uid || !montoNum) return enviarJson(req, res, 400, { ok: false, mensaje: 'Faltan datos (uid y monto son obligatorios).' });

    const userRef = db.collection('saldo_usuarios').doc(uid);
    const movRef = db.collection('saldo_movimientos').doc();
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        if (!snap.exists) throw new Error('NO_EXISTE');
        tx.update(userRef, { saldo: admin.firestore.FieldValue.increment(montoNum) });
        tx.set(movRef, {
          usuarioUid: uid, tipo: 'carga', metodo: 'ajuste-admin',
          monto: montoNum, motivo: motivo || '', estado: 'completado', fecha: Date.now()
        });
      });
      return enviarJson(req, res, 200, { ok: true });
    } catch (e) {
      return enviarJson(req, res, 400, { ok: false, mensaje: e.message === 'NO_EXISTE' ? 'No se encontró ese usuario.' : 'No se pudo ajustar el saldo.' });
    }
  }

  return enviarJson(req, res, 404, { ok: false, motivo: 'RUTA_DE_SALDO_NO_ENCONTRADA' });
}

// ============================================================
// SERVIDOR
// ============================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headersCORS(req));
    return res.end();
  }

  // Rutas de saldo: tienen su propia autenticación (idToken de
  // Firebase, X-Admin-Key o X-MP-Secret), así que se resuelven
  // ANTES del chequeo de X-Site-Key de acá abajo, que es solo
  // para las rutas viejas de FlashTopup.
  if (url.pathname.startsWith('/saldo/')) {
    return manejarRutaSaldo(req, res, url);
  }

  // ---------- GET /debug-servicios (diagnóstico, protegido) ----------
  if (req.method === 'GET' && url.pathname === '/debug-servicios') {
    if (!siteKeyValida(req)) return enviarJson(req, res, 401, { ok: false, motivo: 'NO_AUTORIZADO' });

    const { httpStatus, data } = await llamarFlashTopup(
      'GET', '/api/reseller/v2/services', 'product_code=' + encodeURIComponent(PRODUCT_CODE_FREE_FIRE), null
    );
    return enviarJson(req, res, 200, { ok: true, modoSandbox: MODO_SANDBOX, httpStatusDeFlashTopup: httpStatus, respuestaCompleta: data });
  }

  if (req.method !== 'POST') {
    return enviarJson(req, res, 405, { ok: false, motivo: 'METODO_NO_PERMITIDO' });
  }

  if (!siteKeyValida(req)) {
    return enviarJson(req, res, 401, { ok: false, motivo: 'NO_AUTORIZADO' });
  }

  const body = await leerBodyJson(req);
  if (body === null) {
    return enviarJson(req, res, 400, { ok: false, motivo: 'BODY_INVALIDO' });
  }

  // ---------- POST /validar-uid ----------
  if (url.pathname === '/validar-uid') {
    const { uid } = body;
    if (!uid || typeof uid !== 'string' || uid.trim().length < 3) {
      return enviarJson(req, res, 400, { ok: false, motivo: 'UID_INVALIDO' });
    }

    const checkBody = {
      user_id: uid.trim(),
      product_code: PRODUCT_CODE_FREE_FIRE,
      validation_code: VALIDATION_CODE_FREE_FIRE,
    };

    const { httpStatus, data } = await llamarFlashTopup('POST', '/api/reseller/v2/check-id', null, checkBody);

    if (!data) return enviarJson(req, res, 502, { ok: false, motivo: 'RESPUESTA_INVALIDA_DE_FLASHTOPUP' });
    if (!data.success) {
      return enviarJson(req, res, httpStatus, { ok: false, motivo: data.error?.code || 'ERROR_DESCONOCIDO', mensaje: data.error?.message || '' });
    }

    const datos = data.data || {};
    return enviarJson(req, res, 200, {
      ok: true,
      valido: (datos.valid ?? datos['válido']) !== false,
      nombreCuenta: datos.account_name || datos['nombre_de_cuenta'] || datos.username || '',
    });
  }

  // ---------- POST /crear-orden ----------
  if (url.pathname === '/crear-orden') {
    const { serviceId, uid, referenceId } = body;

    if (!PAQUETES_FREE_FIRE[serviceId]) return enviarJson(req, res, 400, { ok: false, motivo: 'PAQUETE_DESCONOCIDO' });
    if (!uid || typeof uid !== 'string' || uid.trim().length < 3) return enviarJson(req, res, 400, { ok: false, motivo: 'UID_INVALIDO' });
    if (!referenceId || typeof referenceId !== 'string') return enviarJson(req, res, 400, { ok: false, motivo: 'REFERENCE_ID_FALTANTE' });

    const ordenBody = {
      service_code: PAQUETES_FREE_FIRE[serviceId].code,
      reference_id: referenceId,
      cantidad: 1,
      user_id: uid.trim(),
    };

    const { httpStatus, data } = await llamarFlashTopup('POST', '/api/reseller/v2/order', null, ordenBody);

    if (!data) return enviarJson(req, res, 502, { ok: false, motivo: 'RESPUESTA_INVALIDA_DE_FLASHTOPUP' });
    if (!data.success) {
      return enviarJson(req, res, httpStatus, {
        ok: false,
        motivo: data.error?.code || 'ERROR_DESCONOCIDO',
        mensaje: data.error?.message || '',
        detalle: data.error || null,
        bodyEnviado: ordenBody,
      });
    }

    const datosOrden = data.data || {};
    return enviarJson(req, res, 200, {
      ok: true,
      orderId: datosOrden.order_id ?? datosOrden.orderId,
      estado: datosOrden.status ?? datosOrden.estado ?? datosOrden.order_status,
      diamantes: PAQUETES_FREE_FIRE[serviceId].diamantes,
    });
  }

  // ---------- POST /consultar-orden ----------
  if (url.pathname === '/consultar-orden') {
    const { orderId, referenceId } = body;
    if (!orderId && !referenceId) return enviarJson(req, res, 400, { ok: false, motivo: 'FALTA_ORDER_ID_O_REFERENCE_ID' });

    const qs = orderId ? 'order_id=' + encodeURIComponent(orderId) : 'reference_id=' + encodeURIComponent(referenceId);
    const { httpStatus, data } = await llamarFlashTopup('GET', '/api/reseller/v2/order/status', qs, null);

    if (!data) return enviarJson(req, res, 502, { ok: false, motivo: 'RESPUESTA_INVALIDA_DE_FLASHTOPUP' });
    if (!data.success) {
      return enviarJson(req, res, httpStatus, { ok: false, motivo: data.error?.code || 'ERROR_DESCONOCIDO', mensaje: data.error?.message || '' });
    }

    const datosConsulta = data.data || {};
    return enviarJson(req, res, 200, {
      ok: true,
      orderId: datosConsulta.order_id ?? datosConsulta.orderId,
      estado: datosConsulta.status ?? datosConsulta.estado ?? datosConsulta.order_status,
      nota: datosConsulta.note ?? datosConsulta.nota ?? '',
    });
  }

  return enviarJson(req, res, 404, { ok: false, motivo: 'RUTA_NO_ENCONTRADA' });
});

server.listen(PORT, () => {
  console.log(`Relay de FlashTopup escuchando en el puerto ${PORT} (modo sandbox: ${MODO_SANDBOX})`);
});
