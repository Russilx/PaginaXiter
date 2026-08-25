/**
 * relay-saldo-endpoints.js
 * ============================================================
 * Pegá este bloque en tu flashtopup-relay-server.js existente
 * (el mismo que ya sirve /validar-uid). Toda la lógica sensible
 * de saldo vive ACÁ, en la VPS con Firebase Admin SDK — no en
 * Cloud Functions, porque no querés activar el plan Blaze.
 *
 * Necesita:
 *   npm install firebase-admin
 *
 * Y que reemplaces los 3 bloques marcados con "REEMPLAZAR:" por
 * tu configuración real / tus funciones reales de FlashTopup.
 *
 * NOVEDAD: se agregaron los endpoints /saldo/admin/* que usa
 * xiterking-saldo-admin.html (panel de admin) para ver cargas
 * pendientes, aprobarlas/rechazarlas, buscar un usuario por UID
 * y ajustar su saldo a mano. Todos piden X-Admin-Key — nunca los
 * llames desde una página pública, solo desde el panel de admin.
 * ============================================================
 */

const admin = require('firebase-admin');

// REEMPLAZAR: inicializá con tu Service Account real (una sola vez
// en todo el server; si ya usás admin.initializeApp() en otro lado,
// borrá este bloque y usá esa instancia).
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require('./serviceAccountKey.json'))
  });
}
const db = admin.firestore();

// Mismos paquetes que en los HTML — mantené los 3 archivos sincronizados.
const PAQUETES = {
  542: { diamantes: 110,  precio: 1.50 },
  543: { diamantes: 341,  precio: 4.30 },
  544: { diamantes: 572,  precio: 7.00 },
  545: { diamantes: 1166, precio: 14.00 },
  546: { diamantes: 2398, precio: 28.00 },
  547: { diamantes: 6160, precio: 70.00 },
};

// Secreto compartido para que el worker de Mercado Pago (Cloudflare)
// pueda pedirle al relay que acredite saldo. Generá uno propio y
// ponelo también como variable de entorno en ese worker.
const MP_SHARED_SECRET = XITERKINGELMEJOR;

// Key de admin para aprobar cargas manuales (transferencia/PayPal/Binance)
// y para todo lo demás del panel de admin (pendientes, ajustar saldo, etc.)
// Usala vos mismo desde el panel — nunca desde el frontend público.
const ADMIN_KEY = process.env.ADMIN_KEY || 'REEMPLAZAR-otra-clave-larga';

// REEMPLAZAR: esta función tiene que llamar a la MISMA API de
// FlashTopup que ya usa tu ruta /validar-uid, pero para EJECUTAR
// la recarga real (no solo consultar el nombre de la cuenta).
// Debe devolver algo truthy si salió bien, y tirar un error si falló.
async function ejecutarRecargaFlashTopup(uidFF, serviceId) {
  throw new Error('ejecutarRecargaFlashTopup no implementada — conectala a tu API de FlashTopup real');
  // Ejemplo orientativo (adaptalo a tu cliente FlashTopup real):
  // const resp = await flashtopupClient.comprar({ uid: uidFF, service_id: serviceId });
  // if (!resp.ok) throw new Error(resp.mensaje || 'FlashTopup rechazó la orden');
  // return resp;
}

function requireSiteKey(req, res, next) {
  if (req.headers['x-site-key'] !== process.env.SITE_KEY /* o tu constante SITE_KEY */) {
    return res.status(403).json({ ok:false, mensaje:'Site key inválida.' });
  }
  next();
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ ok:false, mensaje:'Falta el token de sesión.' });
  try {
    req.usuario = await admin.auth().verifyIdToken(idToken);
    next();
  } catch (e) {
    res.status(401).json({ ok:false, mensaje:'Sesión inválida o vencida.' });
  }
}

// Mismo chequeo que ya usaban /saldo/aprobar-carga, ahora reutilizado
// por todas las rutas /saldo/admin/*.
function requireAdminKey(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ ok:false, mensaje:'No autorizado.' });
  }
  next();
}

module.exports = function registrarEndpointsSaldo(app) {

  /**
   * POST /saldo/comprar
   * Body: { uidFF, packageId }
   * Header: Authorization: Bearer <idToken>, X-Site-Key
   *
   * Débito atómico en Firestore + ejecución real en FlashTopup.
   * Si FlashTopup falla después de descontar, se revierte el saldo.
   */
  app.post('/saldo/comprar', requireSiteKey, requireAuth, async (req, res) => {
    const { uidFF, packageId } = req.body || {};
    const paquete = PAQUETES[packageId];
    const uid = req.usuario.uid;

    if (!uidFF || !paquete) {
      return res.status(400).json({ ok:false, mensaje:'Datos de compra inválidos.' });
    }

    const userRef = db.collection('saldo_usuarios').doc(uid);
    const movRef = db.collection('saldo_movimientos').doc();

    // 1) Débito atómico — si no hay saldo suficiente, no pasa de acá.
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const saldoActual = snap.exists ? (snap.data().saldo || 0) : 0;
        if (saldoActual < paquete.precio) {
          throw new Error('SALDO_INSUFICIENTE');
        }
        tx.update(userRef, { saldo: admin.firestore.FieldValue.increment(-paquete.precio) });
        tx.set(movRef, {
          usuarioUid: uid, tipo: 'compra', monto: paquete.precio,
          diamantes: paquete.diamantes, uidFF, packageId,
          estado: 'procesando', fecha: Date.now()
        });
      });
    } catch (e) {
      if (e.message === 'SALDO_INSUFICIENTE') {
        return res.status(400).json({ ok:false, mensaje:'Saldo insuficiente.' });
      }
      return res.status(500).json({ ok:false, mensaje:'No se pudo procesar el débito.' });
    }

    // 2) Ejecutar la recarga real. Si falla, revertimos el saldo.
    try {
      await ejecutarRecargaFlashTopup(uidFF, packageId);
      await movRef.update({ estado: 'completado' });
      return res.json({ ok:true, diamantes: paquete.diamantes });
    } catch (e) {
      await db.runTransaction(async (tx) => {
        tx.update(userRef, { saldo: admin.firestore.FieldValue.increment(paquete.precio) });
        tx.update(movRef, { estado: 'fallido', error: String(e.message || e) });
      });
      return res.status(502).json({ ok:false, mensaje:'FlashTopup no pudo procesar la recarga. Se devolvió tu saldo.' });
    }
  });

  /**
   * POST /saldo/aprobar-carga
   * Header: X-Admin-Key
   * Body: { movimientoId }
   *
   * Usalo desde el panel de admin (o a mano) para aprobar una carga
   * por transferencia/PayPal/Binance una vez que verificaste el
   * comprobante. Acredita el monto en saldo_usuarios.
   */
  app.post('/saldo/aprobar-carga', requireAdminKey, async (req, res) => {
    const { movimientoId } = req.body || {};
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
      res.json({ ok:true });
    } catch (e) {
      res.status(400).json({ ok:false, mensaje: e.message === 'YA_PROCESADA' ? 'Esa carga ya fue procesada.' : 'No se encontró la carga.' });
    }
  });

  /**
   * POST /saldo/rechazar-carga
   * Header: X-Admin-Key
   * Body: { movimientoId, motivo }
   *
   * Contraparte de /saldo/aprobar-carga: marca la carga pendiente
   * como "rechazada" y NO toca el saldo. Usalo cuando el comprobante
   * no cierra (monto distinto, referencia inválida, etc.).
   */
  app.post('/saldo/rechazar-carga', requireAdminKey, async (req, res) => {
    const { movimientoId, motivo } = req.body || {};
    const movRef = db.collection('saldo_movimientos').doc(movimientoId);

    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(movRef);
        if (!snap.exists) throw new Error('NO_EXISTE');
        const mov = snap.data();
        if (mov.estado !== 'pendiente') throw new Error('YA_PROCESADA');
        tx.update(movRef, { estado: 'rechazado', motivoRechazo: motivo || '' });
      });
      res.json({ ok:true });
    } catch (e) {
      res.status(400).json({ ok:false, mensaje: e.message === 'YA_PROCESADA' ? 'Esa carga ya fue procesada.' : 'No se encontró la carga.' });
    }
  });

  /**
   * POST /saldo/acreditar-mp
   * Header: X-MP-Secret
   * Body: { usuarioUid, monto, referenciaPago }
   *
   * Tu worker de Mercado Pago (Cloudflare) llama a ESTE endpoint
   * cuando recibe el webhook de pago aprobado — así el worker no
   * necesita hablar con Firestore directo, solo con este relay.
   */
  app.post('/saldo/acreditar-mp', async (req, res) => {
    if (req.headers['x-mp-secret'] !== MP_SHARED_SECRET) {
      return res.status(403).json({ ok:false, mensaje:'No autorizado.' });
    }
    const { usuarioUid, monto, referenciaPago } = req.body || {};
    if (!usuarioUid || !monto || monto <= 0) {
      return res.status(400).json({ ok:false, mensaje:'Datos inválidos.' });
    }
    const userRef = db.collection('saldo_usuarios').doc(usuarioUid);
    const movRef = db.collection('saldo_movimientos').doc();
    await db.runTransaction(async (tx) => {
      tx.update(userRef, { saldo: admin.firestore.FieldValue.increment(monto) });
      tx.set(movRef, {
        usuarioUid, tipo: 'carga', metodo: 'mercadopago', monto,
        referencia: referenciaPago || '', estado: 'completado', fecha: Date.now()
      });
    });
    res.json({ ok:true });
  });

  /**
   * GET /saldo/admin/pendientes
   * Header: X-Admin-Key
   *
   * Devuelve las cargas manuales (transferencia/PayPal/Binance) que
   * están esperando aprobación, con el email del usuario incluido
   * para que el panel de admin no tenga que adivinar de quién es.
   */
  app.get('/saldo/admin/pendientes', requireAdminKey, async (req, res) => {
    try {
      const snap = await db.collection('saldo_movimientos')
        .where('estado', '==', 'pendiente')
        .orderBy('fecha', 'asc')
        .get();

      const uids = [...new Set(snap.docs.map(d => d.data().usuarioUid))];
      const emailsPorUid = {};
      await Promise.all(uids.map(async (uid) => {
        const uSnap = await db.collection('saldo_usuarios').doc(uid).get();
        emailsPorUid[uid] = uSnap.exists ? (uSnap.data().email || '') : '';
      }));

      const pendientes = snap.docs.map(d => ({
        id: d.id, ...d.data(), email: emailsPorUid[d.data().usuarioUid] || ''
      }));
      res.json({ ok:true, pendientes });
    } catch (e) {
      res.status(500).json({ ok:false, mensaje:'No se pudieron cargar las cargas pendientes.' });
    }
  });

  /**
   * GET /saldo/admin/usuario?uid=... o ?email=...
   * Header: X-Admin-Key
   *
   * Devuelve el saldo y los últimos 30 movimientos de un usuario,
   * para la pestaña "Buscar usuario" del panel de admin.
   */
  app.get('/saldo/admin/usuario', requireAdminKey, async (req, res) => {
    try {
      let { uid, email } = req.query || {};

      if (!uid && email) {
        const q = await db.collection('saldo_usuarios').where('email', '==', email).limit(1).get();
        if (q.empty) return res.status(404).json({ ok:false, mensaje:'No se encontró ningún usuario con ese email.' });
        uid = q.docs[0].id;
      }
      if (!uid) return res.status(400).json({ ok:false, mensaje:'Falta uid o email.' });

      const uSnap = await db.collection('saldo_usuarios').doc(uid).get();
      if (!uSnap.exists) return res.status(404).json({ ok:false, mensaje:'No se encontró ese usuario.' });

      const movSnap = await db.collection('saldo_movimientos')
        .where('usuarioUid', '==', uid)
        .orderBy('fecha', 'desc')
        .limit(30)
        .get();

      res.json({
        ok:true,
        uid,
        usuario: uSnap.data(),
        movimientos: movSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      });
    } catch (e) {
      res.status(500).json({ ok:false, mensaje:'No se pudo cargar ese usuario.' });
    }
  });

  /**
   * POST /saldo/admin/ajustar-saldo
   * Header: X-Admin-Key
   * Body: { uid, monto, motivo }
   *
   * Ajuste manual de saldo (positivo para sumar, negativo para
   * descontar). Para correcciones puntuales — errores de carga,
   * compensaciones, etc. Queda registrado como movimiento tipo
   * "ajuste" para que se vea en el historial.
   */
  app.post('/saldo/admin/ajustar-saldo', requireAdminKey, async (req, res) => {
    const { uid, monto, motivo } = req.body || {};
    const montoNum = Number(monto);
    if (!uid || !montoNum) {
      return res.status(400).json({ ok:false, mensaje:'Faltan datos (uid y monto son obligatorios).' });
    }

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
      res.json({ ok:true });
    } catch (e) {
      res.status(400).json({ ok:false, mensaje: e.message === 'NO_EXISTE' ? 'No se encontró ese usuario.' : 'No se pudo ajustar el saldo.' });
    }
  });

  /**
   * GET /saldo/admin/movimientos-recientes?limit=50
   * Header: X-Admin-Key
   *
   * Actividad global (cargas Y compras, de todos los estados) para
   * la pestaña "Actividad reciente" del panel de admin — pensada
   * para un vistazo rápido, no para auditoría exhaustiva.
   */
  app.get('/saldo/admin/movimientos-recientes', requireAdminKey, async (req, res) => {
    try {
      const limite = Math.min(Number(req.query.limit) || 50, 200);
      const snap = await db.collection('saldo_movimientos')
        .orderBy('fecha', 'desc')
        .limit(limite)
        .get();

      const uids = [...new Set(snap.docs.map(d => d.data().usuarioUid))];
      const emailsPorUid = {};
      await Promise.all(uids.map(async (uid) => {
        const uSnap = await db.collection('saldo_usuarios').doc(uid).get();
        emailsPorUid[uid] = uSnap.exists ? (uSnap.data().email || '') : '';
      }));

      const movimientos = snap.docs.map(d => ({
        id: d.id, ...d.data(), email: emailsPorUid[d.data().usuarioUid] || ''
      }));
      res.json({ ok:true, movimientos });
    } catch (e) {
      res.status(500).json({ ok:false, mensaje:'No se pudo cargar la actividad reciente.' });
    }
  });

};

/**
 * En tu server principal:
 *
 *   const registrarEndpointsSaldo = require('./relay-saldo-endpoints');
 *   registrarEndpointsSaldo(app);
 *
 * Índices de Firestore que probablemente te va a pedir crear la
 * primera vez que uses /saldo/admin/pendientes y /saldo/admin/usuario
 * (Firestore te tira un link directo en el error de consola — solo
 * hace falta clickearlo la primera vez):
 *   - saldo_movimientos: estado ASC, fecha ASC
 *   - saldo_movimientos: usuarioUid ASC, fecha DESC
 */
