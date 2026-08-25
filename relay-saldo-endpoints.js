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
const MP_SHARED_SECRET = process.env.MP_SHARED_SECRET || 'REEMPLAZAR-generar-uno-largo';

// Key de admin para aprobar cargas manuales (transferencia/PayPal/Binance).
// Usala vos mismo desde un panel, curl, o Postman — nunca desde el frontend público.
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
   * Usalo vos (no el frontend público) para aprobar una carga por
   * transferencia/PayPal/Binance una vez que verificaste el comprobante.
   */
  app.post('/saldo/aprobar-carga', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) {
      return res.status(403).json({ ok:false, mensaje:'No autorizado.' });
    }
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

};

/**
 * En tu server principal:
 *
 *   const registrarEndpointsSaldo = require('./relay-saldo-endpoints');
 *   registrarEndpointsSaldo(app);
 */
