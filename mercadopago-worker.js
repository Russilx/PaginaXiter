// ============================================================
// WORKER "mercadopago-proxy" — pagos automáticos con Mercado Pago
// para XITERKING STORE (saldo, productos de la tienda y diamantes
// de Free Fire), sin que vos tengas que verificar nada a mano.
//
// CÓMO FUNCIONA (resumen)
// ------------------------------------------------------------
// 1. Tu sitio le pide a ESTE worker: "creá un link de pago para
//    tal cosa" (POST /crear-preferencia). El worker guarda un
//    documento "pendiente" en Firestore y le pide a Mercado Pago
//    un link de pago (Checkout Pro). Te devuelve ese link.
// 2. Redirigís al cliente a ese link. Paga con lo que quiera
//    (tarjeta, dinero en cuenta, etc), Mercado Pago se encarga de
//    todo el proceso de cobro.
// 3. Cuando el pago se aprueba, Mercado Pago le avisa SOLO a este
//    worker (POST /webhook-mercadopago) — nunca a tu navegador,
//    así que no depende de que el cliente vuelva a tu web.
// 4. El worker, ANTES de creerle nada al aviso, le pregunta
//    directamente a la API de Mercado Pago "che, ¿este pago está
//    realmente aprobado?" (esto es clave: nunca hay que confiar
//    en el contenido del webhook en sí, cualquiera podría mandar
//    uno falso — pero nadie puede falsear la respuesta oficial de
//    la API). Si es así, acredita solo, sin que vos hagas nada.
//
// ------------------------------------------------------------
// CÓMO CONSEGUIR TU ACCESS TOKEN DE MERCADO PAGO
// ------------------------------------------------------------
// 1. Andá a https://www.mercadopago.com.ar/developers/panel
//    e iniciá sesión con la cuenta de Mercado Pago donde querés
//    recibir la plata (la misma de siempre).
// 2. "Tus integraciones" → "Crear aplicación". Nombre: cualquiera
//    (ej: "XITERKING STORE"). Modelo de integración: "Pagos online".
//    Producto: "Checkout Pro".
// 3. Ya adentro de la aplicación, pestaña "Credenciales de prueba":
//    ahí tenés un Access Token que arranca con TEST- , usalo
//    primero para probar todo el flujo SIN cobrar plata real.
// 4. Cuando ya probaste que funciona, pestaña "Credenciales de
//    producción" te da el Access Token real (arranca con
//    APP_USR-). Ese es el que cobra de verdad.
// 5. NUNCA pongas ese token en un archivo .js de tu sitio (como
//    firebase-config.js) — va SOLO acá, como secret del worker.
//
// ------------------------------------------------------------
// CÓMO DESPLEGAR ESTO (una sola vez, gratis)
// ------------------------------------------------------------
// 1. https://dash.cloudflare.com/ → Workers & Pages → "Create" →
//    "Create Worker". Nombre, ej: "mercadopago-proxy". Deploy.
// 2. "Edit code" → pegá TODO este archivo reemplazando lo que
//    venga por defecto. Deploy.
// 3. Settings → Variables and Secrets → "Add", todas como tipo
//    "Secret":
//      MP_ACCESS_TOKEN   -> tu Access Token de Mercado Pago
//                            (empezá con el de TEST-)
//      SITE_KEY          -> inventate una clave random (podés
//                            generarla en uuidgenerator.net),
//                            tiene que ser IDÉNTICA a la que
//                            cargues en firebase-config.js en
//                            MERCADOPAGO_SITE_KEY
//      ALLOWED_ORIGIN    -> el dominio de tu sitio, ej:
//                            https://xiterking-store.web.app
//                            (sin barra al final)
//      FIREBASE_PROJECT_ID -> el projectId de firebase-config.js
//                            (ej: xiterking-store-83624)
//      FLASHTOPUP_WORKER_URL -> la URL de tu worker flashtopup-proxy
//                            (solo hace falta si vas a vender
//                            diamantes con Mercado Pago)
//      FLASHTOPUP_SITE_KEY -> la SITE_KEY de ese mismo worker
// 4. Copiá la URL que te da Cloudflare (algo como
//    https://mercadopago-proxy.tu-usuario.workers.dev) y pegala
//    en firebase-config.js en MERCADOPAGO_WORKER_URL. La SITE_KEY
//    que inventaste también va ahí en MERCADOPAGO_SITE_KEY.
// 5. En el panel de Mercado Pago Developers → tu aplicación →
//    "Webhooks" → configurá la URL de notificación:
//    https://mercadopago-proxy.tu-usuario.workers.dev/webhook-mercadopago
//    Evento a escuchar: "Pagos".
// 6. Probá primero TODO con el Access Token de TEST- y con
//    tarjetas de prueba de Mercado Pago (las da su documentación
//    de "Tarjetas de prueba"). Recién cuando confirmes que el
//    saldo se acredita solo, cambiá MP_ACCESS_TOKEN al de
//    producción (APP_USR-).
// ============================================================

const MP_HOST = 'https://api.mercadopago.com';

// ---------- utilidades Firestore REST (mismo estilo que worker.js) ----------

function firestoreUrl(env, path) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
}

async function firestoreGet(env, path) {
  const res = await fetch(firestoreUrl(env, path));
  if (!res.ok) return null;
  return res.json();
}

async function firestoreCreate(env, coleccion, fields) {
  const res = await fetch(firestoreUrl(env, coleccion), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error('No se pudo crear el documento en Firestore: ' + (await res.text()));
  const data = await res.json();
  // el "name" viene como .../documents/coleccion/ID -> nos quedamos con el ID
  return data.name.split('/').pop();
}

async function firestorePatch(env, path, fields, updateMaskFields) {
  const mask = updateMaskFields.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const res = await fetch(firestoreUrl(env, path) + `?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error('No se pudo actualizar el documento en Firestore: ' + (await res.text()));
  return res.json();
}

function num(v) { return { doubleValue: v }; }
function str(v) { return { stringValue: v }; }
function bool(v) { return { booleanValue: v }; }
function ts(v) { return { timestampValue: v }; }

// lee un valor simple de un doc de Firestore (formato REST) por nombre de campo
function campo(doc, nombre) {
  if (!doc || !doc.fields || !doc.fields[nombre]) return null;
  const f = doc.fields[nombre];
  if ('doubleValue' in f) return f.doubleValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('stringValue' in f) return f.stringValue;
  if ('booleanValue' in f) return f.booleanValue;
  return null;
}

// ---------- CORS ----------

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
    headers: { 'Content-Type': 'application/json', ...(cors || {}) },
  });
}

function siteKeyValida(request, env) {
  return request.headers.get('X-Site-Key') === env.SITE_KEY && !!env.SITE_KEY;
}

// ============================================================
// RUTAS
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origenPedido = request.headers.get('Origin') || '';
    const cors = headersCORS(origenPedido, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // ---------- POST /crear-preferencia ----------
    // body esperado según "tipo":
    //   saldo:     { tipo:'saldo', usuarioId, nombre, email, monto, montoSaldo }
    //   producto:  { tipo:'producto', usuarioId, nombre, email, monto, descripcion, itemsResumen }
    //   diamantes: { tipo:'diamantes', usuarioId, nombre, email, monto, serviceId, uid, diamantes }
    // "monto" siempre en pesos argentinos (ARS), es lo que se le cobra
    // al cliente en el checkout de Mercado Pago.
    if (request.method === 'POST' && url.pathname === '/crear-preferencia') {
      if (!siteKeyValida(request, env)) {
        return jsonResponse({ ok: false, motivo: 'NO_AUTORIZADO' }, 401, cors);
      }

      let body;
      try { body = await request.json(); } catch (e) {
        return jsonResponse({ ok: false, motivo: 'BODY_INVALIDO' }, 400, cors);
      }

      const { tipo, usuarioId, nombre, email, monto, descripcion } = body;

      if (!['saldo', 'producto', 'diamantes'].includes(tipo)) {
        return jsonResponse({ ok: false, motivo: 'TIPO_INVALIDO' }, 400, cors);
      }
      if (!usuarioId || !monto || monto <= 0) {
        return jsonResponse({ ok: false, motivo: 'DATOS_INCOMPLETOS' }, 400, cors);
      }

      // 1) guardamos un doc "pendiente" con todo lo que hace falta
      //    para acreditar cuando llegue el webhook aprobado.
      const pagoFields = {
        tipo: str(tipo),
        usuarioId: str(usuarioId),
        nombre: str(nombre || ''),
        email: str(email || ''),
        monto: num(monto),
        estado: str('pendiente'),
        creado: ts(new Date().toISOString()),
      };
      if (tipo === 'saldo') {
        pagoFields.montoSaldo = num(body.montoSaldo || monto);
      }
      if (tipo === 'producto') {
        pagoFields.itemsResumen = str(body.itemsResumen || '');
      }
      if (tipo === 'diamantes') {
        pagoFields.serviceId = num(body.serviceId);
        pagoFields.uidFreeFire = str(body.uid || '');
        pagoFields.diamantes = num(body.diamantes || 0);
      }

      let pagoId;
      try {
        pagoId = await firestoreCreate(env, 'pagosMercadoPago', pagoFields);
      } catch (err) {
        return jsonResponse({ ok: false, motivo: 'ERROR_FIRESTORE', mensaje: err.message }, 500, cors);
      }

      // 2) le pedimos a Mercado Pago el link de pago (Checkout Pro)
      const preferenceBody = {
        items: [{
          title: descripcion || 'Compra en XITERKING STORE',
          quantity: 1,
          unit_price: Number(monto),
          currency_id: 'ARS',
        }],
        external_reference: pagoId,
        notification_url: `${url.origin}/webhook-mercadopago`,
        // usamos la misma página de origen (recarga.html, producto.html,
        // etc, la que mandó "returnPath") agregando ?mp=... para que el
        // sitio le muestre al cliente el cartel correspondiente al volver.
        back_urls: {
          success: env.ALLOWED_ORIGIN + (body.returnPath || '/recarga.html') + '?mp=exito',
          failure: env.ALLOWED_ORIGIN + (body.returnPath || '/recarga.html') + '?mp=fallo',
          pending: env.ALLOWED_ORIGIN + (body.returnPath || '/recarga.html') + '?mp=pendiente',
        },
        auto_return: 'approved',
      };

      const mpRes = await fetch(`${MP_HOST}/checkout/preferences`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(preferenceBody),
      });

      const mpData = await mpRes.json();
      if (!mpRes.ok) {
        return jsonResponse({ ok: false, motivo: 'ERROR_MERCADOPAGO', detalle: mpData }, 502, cors);
      }

      // el Access Token de TEST- devuelve "sandbox_init_point" (checkout de
      // prueba); el de producción devuelve "init_point" (checkout real).
      const linkPago = mpData.init_point || mpData.sandbox_init_point;

      return jsonResponse({ ok: true, linkPago, pagoId }, 200, cors);
    }

    // ---------- POST /webhook-mercadopago ----------
    // A esta ruta le pega Mercado Pago solo, nunca tu sitio. No
    // necesita X-Site-Key (Mercado Pago no lo manda), la seguridad acá
    // pasa por NUNCA confiar en lo que dice el aviso y siempre volver
    // a preguntarle a la API de Mercado Pago si el pago está aprobado.
    if (request.method === 'POST' && url.pathname === '/webhook-mercadopago') {
      // Mercado Pago manda el id del pago como query param (formato
      // nuevo) o adentro del body (formato viejo) según cómo esté
      // configurada la app — contemplamos los dos.
      let paymentId = url.searchParams.get('data.id') || url.searchParams.get('id');
      const topic = url.searchParams.get('type') || url.searchParams.get('topic');

      if (!paymentId) {
        try {
          const body = await request.json();
          if (body?.data?.id) paymentId = body.data.id;
        } catch (e) { /* sin body, no pasa nada */ }
      }

      if (!paymentId || (topic && topic !== 'payment')) {
        // no era una notificación de pago (puede ser de otro tipo,
        // ej "merchant_order") — respondemos 200 igual para que
        // Mercado Pago no reintente sin sentido.
        return new Response('OK', { status: 200 });
      }

      // consultamos el pago REAL contra la API, con nuestro Access
      // Token — esto es lo que no se puede falsificar.
      const pagoRes = await fetch(`${MP_HOST}/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${env.MP_ACCESS_TOKEN}` },
      });
      if (!pagoRes.ok) return new Response('OK', { status: 200 });
      const pago = await pagoRes.json();

      if (pago.status !== 'approved') {
        // pendiente, rechazado, etc — no acreditamos nada todavía.
        // Si más adelante llega otro webhook con status "approved"
        // para el mismo pago, ese sí lo procesa.
        return new Response('OK', { status: 200 });
      }

      const pagoDocId = pago.external_reference;
      if (!pagoDocId) return new Response('OK', { status: 200 });

      const pagoDoc = await firestoreGet(env, `pagosMercadoPago/${pagoDocId}`);
      if (!pagoDoc) return new Response('OK', { status: 200 });

      // idempotencia: Mercado Pago puede reintentar el mismo webhook
      // varias veces — si ya lo acreditamos antes, no lo hacemos de nuevo.
      if (campo(pagoDoc, 'estado') === 'acreditado') {
        return new Response('OK', { status: 200 });
      }

      const tipo = campo(pagoDoc, 'tipo');
      const usuarioId = campo(pagoDoc, 'usuarioId');

      try {
        if (tipo === 'saldo') {
          const montoSaldo = campo(pagoDoc, 'montoSaldo') || 0;
          const userDoc = await firestoreGet(env, `registros/${usuarioId}`);
          const saldoActual = campo(userDoc, 'saldo') || 0;
          await firestorePatch(env, `registros/${usuarioId}`,
            { saldo: num(saldoActual + montoSaldo) }, ['saldo']);
        }

        if (tipo === 'producto') {
          // acá solo marcamos la/las compras_pendientes asociadas como
          // confirmadas — el resto del flujo de entrega de keys sigue
          // siendo el mismo que ya usás para compras aprobadas por vos.
          // (si querés que también entregue automático, hay que sumar
          // ese paso puntual, avisame y lo armamos.)
        }

        if (tipo === 'diamantes' && env.FLASHTOPUP_WORKER_URL) {
          const serviceId = campo(pagoDoc, 'serviceId');
          const uidFreeFire = campo(pagoDoc, 'uidFreeFire');
          await fetch(`${env.FLASHTOPUP_WORKER_URL}/crear-orden`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Site-Key': env.FLASHTOPUP_SITE_KEY,
            },
            body: JSON.stringify({
              serviceId,
              uid: uidFreeFire,
              referenceId: `mp-${pagoDocId}`,
            }),
          });
        }

        await firestorePatch(env, `pagosMercadoPago/${pagoDocId}`, {
          estado: str('acreditado'),
          paymentId: str(String(paymentId)),
          acreditado: ts(new Date().toISOString()),
        }, ['estado', 'paymentId', 'acreditado']);
      } catch (err) {
        // si algo falla acá, NO marcamos como acreditado — así, si
        // Mercado Pago reintenta el webhook más tarde, se vuelve a
        // intentar acreditar en vez de perderse el pago.
        console.error('Error al acreditar pago de Mercado Pago:', err);
      }

      return new Response('OK', { status: 200 });
    }

    return jsonResponse({ ok: false, motivo: 'RUTA_NO_ENCONTRADA' }, 404, cors);
  },
};
