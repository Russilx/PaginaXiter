// ============================================================
// BOT DE VENTAS — XITERKING STORE
// ------------------------------------------------------------
// QUÉ HACE: es UN SOLO bot de Discord (un solo token) que le sirve
// a VARIOS clientes al mismo tiempo. Cuando alguien usa el comando
// /venta-ticket en SU servidor, el bot busca en Firestore qué
// configuración corresponde a ESE servidor (por su guildId, en la
// colección "ventasbotConfigs" que llena cada cliente desde su
// panel ventasbot.html) y publica el mensaje de venta ahí, con el
// formato que ese cliente eligió.
//
// Si el servidor no tiene una configuración APROBADA por el admin
// (ver admin.html → pestaña "Bot Ventas"), el comando no hace nada
// más que avisarle a quien lo usó que todavía no está habilitado.
//
// También publica, de forma automática y periódica, un resumen de
// ventas por cliente (diario / semanal / mensual / desactivado,
// según lo que cada cliente eligió en su panel).
//
// ------------------------------------------------------------
// CÓMO DESPLEGAR ESTO (en la misma VPS del relay de FlashTopup)
// ------------------------------------------------------------
// 1. CREÁ LA APLICACIÓN DE DISCORD Y EL BOT
//    a) Andá a https://discord.com/developers/applications → "New
//       Application" → ponele un nombre (ej: "XITERKING Ventas").
//    b) Menú lateral "Bot" → "Add Bot" → confirmá.
//    c) En esa misma pantalla, activá "MESSAGE CONTENT INTENT" si
//       en el futuro querés que lea mensajes (no hace falta para
//       este bot tal cual está, que solo usa slash commands).
//    d) "Reset Token" → copiá el token que te muestra UNA sola vez.
//       Ese es tu DISCORD_BOT_TOKEN (guardalo ahora, no se puede
//       volver a ver después sin resetearlo de nuevo).
//    e) Menú lateral "OAuth2" → "URL Generator" → tildá "bot" y
//       "applications.commands", y en permisos tildá al menos
//       "Send Messages", "Embed Links" y "Use Slash Commands".
//       Copiá la URL que genera abajo — ESE es el link que le
//       pasás a cada cliente para invitar el bot a su servidor.
//
// 2. CONSEGUÍ LAS CREDENCIALES DE FIREBASE ADMIN (distintas de las
//    que usa el sitio web — esas son "públicas", estas son privadas
//    y con permiso total sobre tu base de datos, así que el bot
//    puede leer y escribir sin las reglas de seguridad del cliente)
//    a) https://console.firebase.google.com/ → tu proyecto →
//       ⚙️ Configuración del proyecto → "Cuentas de servicio".
//    b) "Generar nueva clave privada" → descarga un .json.
//    c) Subí ese archivo a la VPS (al lado de este index.js) con
//       el nombre "firebase-admin-key.json". NUNCA lo subas a
//       GitHub ni lo compartas — tiene acceso total a tu Firestore.
//
// 3. EN LA VPS (la misma donde ya tenés flashtopup-relay-server.js)
//      cd /la/carpeta/de/siempre
//      mkdir ventas-bot && cd ventas-bot
//      (subí acá index.js, package.json y firebase-admin-key.json)
//      npm install
//      nano .env
//    y pegá:
//      DISCORD_BOT_TOKEN=el-token-del-paso-1d
//    Guardá con Ctrl+O, salí con Ctrl+X.
//
// 4. PROBALO A MANO UNA VEZ
//      node --env-file=.env index.js
//    Tiene que imprimir "Bot de ventas conectado como ...". Dejalo
//    un segundo, Ctrl+C.
//
// 5. DEJALO CORRIENDO SIEMPRE CON PM2 (junto al relay de FlashTopup)
//      pm2 start index.js --name ventas-bot --env-file .env
//      pm2 save
//    (si ya corriste "pm2 startup" antes para el relay, no hace
//    falta repetirlo — un solo pm2 administra todos los procesos).
//
// 6. INVITÁ EL BOT a tu propio servidor de Discord y al de cada
//    cliente aprobado, con el link del paso 1e.
//
// NOTA SOBRE LOS SLASH COMMANDS: la primera vez que arranca, el bot
// registra /venta-ticket como comando GLOBAL (funciona en cualquier
// servidor donde esté invitado). Discord puede tardar hasta 1 hora
// en mostrarlo la primera vez — después los cambios son casi
// instantáneos.
// ============================================================

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField,
} = require('discord.js');
const admin = require('firebase-admin');
const cron = require('node-cron');

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_BOT_TOKEN) {
  console.error('Falta DISCORD_BOT_TOKEN en el .env');
  process.exit(1);
}

// ---------- Firebase Admin ----------
admin.initializeApp({
  credential: admin.credential.cert(require('./firebase-admin-key.json')),
});
const db = admin.firestore();

// ---------- Discord client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ============================================================
// REGISTRO DEL SLASH COMMAND
// ============================================================
const comandoVentaTicket = new SlashCommandBuilder()
  .setName('venta-ticket')
  .setDescription('Registra una venta y la publica en el canal de ventas configurado.')
  .addStringOption(opt =>
    opt.setName('producto').setDescription('Qué se vendió').setRequired(true))
  .addStringOption(opt =>
    opt.setName('monto').setDescription('Monto de la venta (con la moneda, ej: 5000 ARS)').setRequired(true))
  .addStringOption(opt =>
    opt.setName('cliente').setDescription('Nombre o usuario del cliente (opcional)').setRequired(false));

async function registrarComandos() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: [comandoVentaTicket.toJSON()] }
  );
  console.log('Slash command /venta-ticket registrado (global).');
}

// ============================================================
// UTILIDADES
// ============================================================

// Reemplaza las variables {vendedor}, {producto}, {monto}, {cliente},
// {numero}, {fecha}, {hora} dentro de un texto.
function reemplazarVariables(texto, vars) {
  if (!texto) return '';
  return texto.replace(/\{(\w+)\}/g, (match, key) => (vars[key] != null ? String(vars[key]) : match));
}

function formatearFechaHora(date) {
  const fecha = date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const hora = date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  return { fecha, hora };
}

// Busca, entre TODAS las configs aprobadas, la que corresponde a
// este servidor de Discord. Como cada cliente tiene su propio
// guildId, esta consulta devuelve como mucho un resultado.
async function buscarConfigPorGuild(guildId) {
  const snap = await db.collection('ventasbotConfigs')
    .where('guildId', '==', guildId)
    .where('estadoAprobacion', '==', 'aprobado')
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

// Siguiente número correlativo de venta para este cliente
// (transacción para que nunca se repita, aunque caigan dos ventas
// casi al mismo tiempo).
async function siguienteNumeroVenta(usuarioId) {
  const ref = db.collection('ventasContadores').doc(usuarioId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const actual = snap.exists ? (snap.data().ultimoNumero || 0) : 0;
    const siguiente = actual + 1;
    tx.set(ref, { ultimoNumero: siguiente }, { merge: true });
    return siguiente;
  });
}

// ============================================================
// SLASH COMMAND: /venta-ticket
// ============================================================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'venta-ticket') return;
  if (!interaction.guildId) {
    return interaction.reply({ content: 'Este comando solo funciona dentro de un servidor.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const config = await buscarConfigPorGuild(interaction.guildId);
    if (!config) {
      return interaction.editReply('Este servidor todavía no tiene el Bot de Ventas habilitado. Pedile a XITERKING STORE que apruebe tu configuración desde tu panel.');
    }

    // ---------- permisos: rol de staff (si hay alguno configurado) ----------
    const rolesPermitidos = (config.staffRoleIds || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (rolesPermitidos.length > 0) {
      const tieneRol = interaction.member.roles.cache.some(r => rolesPermitidos.includes(r.id));
      if (!tieneRol) {
        return interaction.editReply('No tenés permiso para cargar ventas en este servidor.');
      }
    }

    // ---------- canal de ventas configurado ----------
    if (!config.canalVentasId) {
      return interaction.editReply('El canal de ventas todavía no está configurado. Avisale al dueño del servidor que lo complete en su panel.');
    }
    const canal = await interaction.guild.channels.fetch(config.canalVentasId).catch(() => null);
    if (!canal || !canal.isTextBased()) {
      return interaction.editReply('No pude encontrar el canal de ventas configurado (puede que se haya borrado). Avisale al dueño del servidor.');
    }
    const permisosBot = canal.permissionsFor(interaction.guild.members.me);
    if (!permisosBot || !permisosBot.has(PermissionsBitField.Flags.SendMessages) || !permisosBot.has(PermissionsBitField.Flags.EmbedLinks)) {
      return interaction.editReply('No tengo permiso para escribir en el canal de ventas configurado. Dale permiso al bot ahí y probá de nuevo.');
    }

    // ---------- arma la venta ----------
    const producto = interaction.options.getString('producto');
    const monto = interaction.options.getString('monto');
    const cliente = interaction.options.getString('cliente') || '—';
    const numero = await siguienteNumeroVenta(config.id);
    const ahora = new Date();
    const { fecha, hora } = formatearFechaHora(ahora);

    const vars = {
      vendedor: `<@${interaction.user.id}>`,
      producto,
      monto,
      cliente,
      numero,
      fecha,
      hora,
    };

    const colorHex = /^#([0-9a-f]{6})$/i.test(config.ventaColorHex) ? config.ventaColorHex : '#e10600';
    const embed = new EmbedBuilder()
      .setColor(parseInt(colorHex.replace('#', ''), 16))
      .setTitle(reemplazarVariables(config.ventaTitulo || 'Nueva venta registrada', vars))
      .setDescription(reemplazarVariables(config.ventaDescripcion || '', vars) || null)
      .setTimestamp(ahora);

    const camposVenta = Array.isArray(config.camposVenta) ? config.camposVenta : [];
    camposVenta.forEach(c => {
      if (!c.nombre) return;
      embed.addFields({
        name: reemplazarVariables(c.nombre, vars),
        value: reemplazarVariables(c.valor, vars) || '—',
        inline: true,
      });
    });

    await canal.send({ embeds: [embed] });

    // ---------- guarda la venta para las estadísticas ----------
    await db.collection('ventas').add({
      usuarioId: config.id,
      guildId: interaction.guildId,
      vendedorId: interaction.user.id,
      vendedorTag: interaction.user.tag,
      producto,
      monto,
      cliente,
      numero,
      fecha: admin.firestore.FieldValue.serverTimestamp(),
    });

    await interaction.editReply(`✅ Venta #${numero} cargada y publicada en <#${canal.id}>.`);
  } catch (err) {
    console.error('Error al procesar /venta-ticket:', err);
    await interaction.editReply('Hubo un problema al cargar la venta. Probá de nuevo o avisale al soporte.').catch(() => {});
  }
});

// ============================================================
// RESUMEN PERIÓDICO DE VENTAS (diario / semanal / mensual)
// ------------------------------------------------------------
// Corre todos los días a las 09:00 (hora del servidor donde vive
// el bot). Revisa, cliente por cliente, si hoy le toca resumen
// según la frecuencia que eligió, y si es así, lo publica.
// ============================================================
cron.schedule('0 9 * * *', async () => {
  console.log('Chequeando resúmenes de ventas del día...');
  try {
    const snap = await db.collection('ventasbotConfigs')
      .where('estadoAprobacion', '==', 'aprobado')
      .get();

    const hoy = new Date();
    const esLunes = hoy.getDay() === 1;
    const esPrimerDiaDeMes = hoy.getDate() === 1;

    for (const doc of snap.docs) {
      const config = { id: doc.id, ...doc.data() };
      const frecuencia = config.statsFrecuencia || 'desactivado';
      if (frecuencia === 'desactivado') continue;
      if (frecuencia === 'semanal' && !esLunes) continue;
      if (frecuencia === 'mensual' && !esPrimerDiaDeMes) continue;
      if (!config.statsCanalId || !config.guildId) continue;

      await publicarResumen(config, frecuencia);
    }
  } catch (err) {
    console.error('Error al chequear resúmenes de ventas:', err);
  }
});

async function publicarResumen(config, frecuencia) {
  try {
    const guild = await client.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) return;
    const canal = await guild.channels.fetch(config.statsCanalId).catch(() => null);
    if (!canal || !canal.isTextBased()) return;

    const desde = calcularInicioPeriodo(frecuencia);
    const ventasSnap = await db.collection('ventas')
      .where('usuarioId', '==', config.id)
      .where('fecha', '>=', admin.firestore.Timestamp.fromDate(desde))
      .get();

    const cantidad = ventasSnap.size;
    let totalNumerico = 0;
    let totalParseable = true;
    ventasSnap.forEach(d => {
      const monto = (d.data().monto || '').replace(/[^\d.,-]/g, '').replace(',', '.');
      const num = parseFloat(monto);
      if (!isNaN(num)) totalNumerico += num;
      else totalParseable = false;
    });

    const embed = new EmbedBuilder()
      .setColor(0xe10600)
      .setTitle(config.statsTitulo || 'Resumen de ventas')
      .addFields({ name: 'Ventas cargadas', value: String(cantidad), inline: true });

    if (cantidad > 0) {
      embed.addFields({
        name: 'Total (aproximado)',
        value: totalParseable
          ? totalNumerico.toLocaleString('es-AR')
          : `${totalNumerico.toLocaleString('es-AR')} (algunos montos no se pudieron sumar, revisar cargas)`,
        inline: true,
      });
    }

    await canal.send({ embeds: [embed] });
  } catch (err) {
    console.error(`Error al publicar el resumen del cliente ${config.id}:`, err);
  }
}

function calcularInicioPeriodo(frecuencia) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (frecuencia === 'diario') return d;
  if (frecuencia === 'semanal') { d.setDate(d.getDate() - 7); return d; }
  if (frecuencia === 'mensual') { d.setDate(d.getDate() - 30); return d; }
  return d;
}

// ============================================================
client.once('ready', async () => {
  console.log(`Bot de ventas conectado como ${client.user.tag}`);
  await registrarComandos();
});

client.login(DISCORD_BOT_TOKEN);
