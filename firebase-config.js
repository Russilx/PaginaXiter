// ============================================================
// CONFIGURACIÓN DE FIREBASE
// ------------------------------------------------------------
// 1. Andá a https://console.firebase.google.com/
// 2. Creá un proyecto nuevo (gratis, no pide tarjeta).
// 3. Adentro del proyecto: ⚙️ Configuración del proyecto > "Tus apps"
//    > ícono </> (Web) > registrá una app.
// 4. Te va a mostrar un objeto firebaseConfig como el de abajo.
//    Copiá esos valores y pegalos acá reemplazando los de ejemplo.
// 5. En el menú lateral: Firestore Database > Crear base de datos
//    (elegí "modo de prueba" para arrancar rápido).
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyDBp_z1tTLo1uGnCjlNGtTmmY8zD5zTyRU",
  authDomain: "xiterking-store-83624.firebaseapp.com",
  projectId: "xiterking-store-83624",
  storageBucket: "xiterking-store-83624.firebasestorage.app",
  messagingSenderId: "345627054896",
  appId: "1:345627054896:web:5171ff700efa067f0e6ef5",
  measurementId: "G-EJPKRVC49Q"
};

// Clave para entrar al panel de administración (cambiala).
export const ADMIN_PASSWORD = "Xiterkingelmejordetodos";


// ============================================================
// EMAILJS — envío automático de email al aprobar un registro
// ------------------------------------------------------------
// 1. Andá a https://www.emailjs.com/ y creá una cuenta gratis.
// 2. "Email Services" > "Add New Service" > conectá tu Gmail.
//    Ahí te da el SERVICE_ID.
// 3. "Email Templates" > "Create New Template". En el campo
//    "To Email" poné {{to_email}} (esto es lo que hace que el
//    mail llegue al cliente y no a vos). En el cuerpo podés usar
//    {{to_name}} para el nombre. Ahí te da el TEMPLATE_ID.
// 4. "Account" > "General" > copiá tu "Public Key".
// ============================================================
export const EMAILJS_SERVICE_ID = "service_aivu3or";
export const EMAILJS_TEMPLATE_ID = "template_ef7d7lt";
export const EMAILJS_PUBLIC_KEY = "pb1npECK_vUc5RZ_K";

// ============================================================
// TELEGRAM — aviso automático a vos cuando aprobás un registro
// ------------------------------------------------------------
// 1. Abrí Telegram y buscá el contacto @BotFather.
// 2. Mandale el mensaje: /newbot
//    Te va a pedir un nombre (cualquiera) y un username que termine
//    en "bot" (ej: xiterking_avisos_bot).
// 3. Al terminar te da un "token" con este formato:
//    123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//    Ese es tu TELEGRAM_BOT_TOKEN.
// 4. Buscá tu bot recién creado por su username y mandale
//    cualquier mensaje (ej: "hola") para "activar" la conversación.
// 5. Buscá el contacto @userinfobot, hablale, y te va a devolver
//    tu "Id" (un número). Ese es tu TELEGRAM_CHAT_ID.
// ============================================================
export const TELEGRAM_BOT_TOKEN = "8850494855:AAHR4tFe9nPrwleAA4FDgZ_iXSpDax3IaVE";
export const TELEGRAM_CHAT_ID = "8621082941";

// ============================================================
// DATOS DE COBRO — se muestran en "Recargar saldo" para que el
// cliente sepa a dónde transferir. Completá los tuyos acá.
// ============================================================
export const DATOS_RECARGA = {
  transferencia: {
    titular: "Esteban Manuel San Martin",
    cbu: "0000003100025300789505",
    alias: "ELESTU2.0"
  },
  paypal: {
    email: "noperdertelover@gmail.com"
  },
  binance: {
    id: "847835648",
    email: "Xiterking"
  }
};

// ============================================================
// TASAS DE CAMBIO — cuántos pesos (o USDT) equivalen a 1 USDT
// de saldo, según el método de pago. El saldo del sitio se
// maneja siempre en USDT: si alguien transfiere pesos, se
// convierte con esta tasa; PayPal y Binance ya están en USDT,
// por eso su tasa es 1. Actualizá "transferencia" cuando
// cambie el dólar.
// ============================================================
export const TASAS_RECARGA = {
  transferencia: 1585,  // 1 USDT = 1520 pesos argentinos
  paypal: 1,             // 1 USDT = 1 USDT
  binance: 1              // 1 USDT = 1 USDT
};

// ============================================================
// DISCORD — link de invitación al servidor, usado en el botón
// "Quiero ser socio" del cartel de promoción.
// ============================================================
export const DISCORD_INVITE = "https://discord.gg/aRydgwHGpf";
// Poné tu número completo, sin espacios ni el "+", con código
// de país y de área. Ej: Argentina 11 1234-5678 -> "5491112345678"
// ============================================================
export const WHATSAPP_RECARGAS = "5491151042005";

// ============================================================
// INSTAGRAM — se usa en el apartado de contacto del pie de
// página de todas las secciones del sitio.
// ============================================================
export const INSTAGRAM_PERSONAL = "https://www.instagram.com/tebi_.04/";

// ============================================================
// IMGBB — se usa para subir las fotos de los productos desde el
// panel de administración (así no depende de Firebase Storage
// ni del plan pago de Firebase).
// ------------------------------------------------------------
// Conseguida en https://api.imgbb.com/ (cuenta gratuita).
// ============================================================
export const IMGBB_API_KEY = "3ab45368d9e1341556fc9313a5c8c807";

// ============================================================
// FLASHTOPUP — recargas automáticas de diamantes de Free Fire
// (recargas-diamantes.html). La clave secreta de FlashTopup
// NUNCA va acá ni en ningún archivo del sitio — vive únicamente
// en el Worker de Cloudflare (ver worker/index.js). Estas dos
// constantes son solo para que tu sitio pueda hablarle a TU
// worker, no a FlashTopup directamente.
// ------------------------------------------------------------
// 1. Desplegá el worker (instrucciones completas en el
//    encabezado de worker/index.js) y copiá la URL que te da
//    Cloudflare acá abajo en FLASHTOPUP_WORKER_URL.
// 2. La SITE_KEY es una clave que vos mismo inventás (no tiene
//    que ver con FlashTopup) y tiene que ser IDÉNTICA a la que
//    cargaste como variable de entorno "SITE_KEY" en el worker.
// ============================================================
export const FLASHTOPUP_WORKER_URL = "https://flashtopup-proxy.xiterkingstore.workers.dev";
export const FLASHTOPUP_SITE_KEY = "e024d865-1779-4723-9d8b-529941fddd9c";
