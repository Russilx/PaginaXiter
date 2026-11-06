import { createClient } from "npm:@supabase/supabase-js@2";

const CO = "https://portal.centraloneglobal.com/api/v1";
const env = (k: string) => Deno.env.get(k)!;
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: cors });

async function co(path: string, init: RequestInit = {}, idem?: string) {
  const r = await fetch(CO + path, {
    ...init,
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${env("CO_API_KEY")}`,
      "Content-Type": "application/json",
      ...(idem ? { "Idempotency-Key": idem } : {}),
    },
  });
  let body: any = null;
  try { body = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body };
}

// Campos del jugador. Si el catálogo pide más (p. ej. server), ponelos en el secret CO_TARGET_EXTRA como JSON.
const target = (id: string) => ({ player_id: id, ...JSON.parse(Deno.env.get("CO_TARGET_EXTRA") || "{}") });
const cerrar = (id: number, ok: boolean, motivo: string | null) =>
  admin.rpc("cerrar_pedido_auto", { p_id: id, p_ok: ok, p_motivo: motivo });

// Tareas que siguen después de responder (si el runtime no lo soporta, igual se ejecutan sin bloquear)
const fondo = (pr: Promise<unknown>) => {
  const q = pr.catch(() => {});
  try { (globalThis as any).EdgeRuntime?.waitUntil(q); } catch { /* sigue igual */ }
};
const panelUrl = () => Deno.env.get("SITE_URL") ? [`Panel: ${Deno.env.get("SITE_URL")}/admin.html`] : [];

// Avisos al admin por Telegram y/o Discord. Cada canal se activa solo si tiene sus secrets.
async function notificar(lineas: string[], username = "XITERKING") {
  const texto = lineas.join("\n");
  const envios: Promise<unknown>[] = [];
  const hook = Deno.env.get("DISCORD_WEBHOOK_URL");
  if (hook) envios.push(fetch(hook, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, embeds: [{ title: lineas[0], description: lineas.slice(1).join("\n"), color: 0xe10600 }] }),
  }));
  // Telegram (gratis y estable). Secrets: TELEGRAM_BOT_TOKEN (de @BotFather) y TELEGRAM_CHAT_ID (tu chat con el bot).
  const tgToken = Deno.env.get("TELEGRAM_BOT_TOKEN"), tgChat = Deno.env.get("TELEGRAM_CHAT_ID");
  if (tgToken && tgChat) envios.push(fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: tgChat, text: texto }),
  }));
  await Promise.allSettled(envios);
}

// Aviso de carga de saldo nueva. La marca "avisado" evita que se envíe dos veces.
async function avisarDeposito(id: number, uid?: string) {
  const { data: d } = await admin.from("depositos")
    .select("id,usuario,metodo,monto,referencia,estado,perfiles(nombre,email)").eq("id", id).single();
  if (!d || d.estado !== "pendiente" || (uid && d.usuario !== uid)) return;
  const { data: marca } = await admin.from("depositos").update({ avisado: true }).eq("id", d.id).eq("avisado", false).select("id");
  if (!marca?.length) return;
  const p: any = d.perfiles;
  await notificar([
    "💰 Nueva carga de saldo pendiente",
    `${p?.nombre || "Sin nombre"} (${p?.email || "sin email"})`,
    `Declaró ${d.metodo === "binance" ? `${d.monto} USDT por Binance` : `$${Number(d.monto).toLocaleString("es-AR")} por Mercado Pago`}`,
    `Comprobante: ${/^foto:/.test(d.referencia || "") ? "📷 foto (verla en el panel)" : d.referencia}`,
    ...panelUrl(),
  ], "XITERKING Saldo");
}

// Alerta de saldo bajo en Central One. Mínimo configurable con el secret CO_SALDO_MINIMO (USD, por defecto 20).
// Avisa como máximo una vez cada 6 horas, y vuelve a avisar enseguida si el saldo se repone y vuelve a bajar.
const MIN_CO = () => Number(Deno.env.get("CO_SALDO_MINIMO") || 20);
async function vigilarSaldo() {
  const r = await co("/balance");
  const disp = Number(r.body?.available_balance);
  if (!Number.isFinite(disp)) return;
  const K = "co_saldo_bajo";
  if (disp >= MIN_CO()) { await admin.from("avisos_sistema").delete().eq("clave", K); return; }
  const { data: prev } = await admin.from("avisos_sistema").select("enviado").eq("clave", K).maybeSingle();
  if (prev) {
    if (Date.now() - new Date(prev.enviado).getTime() < 6 * 3600 * 1000) return;
    const { data: ok } = await admin.from("avisos_sistema").update({ enviado: new Date().toISOString() }).eq("clave", K).eq("enviado", prev.enviado).select("clave");
    if (!ok?.length) return;
  } else {
    const { error } = await admin.from("avisos_sistema").insert({ clave: K });
    if (error) return;
  }
  await notificar([
    "⚠️ Saldo bajo en Central One",
    `Quedan ${disp} USD disponibles (mínimo configurado: ${MIN_CO()} USD).`,
    "Cargá saldo en Central One para que las recargas de tus clientes no se rechacen.",
    ...panelUrl(),
  ], "XITERKING Alertas");
}

// Envía el pedido a Central One. Idempotency-Key fija por pedido: reintentar nunca cobra dos veces.
async function enviar(p: any) {
  const { data: pk } = await admin.from("paquetes").select("co_product_id").eq("diamantes", p.diamantes).single();
  if (!pk?.co_product_id) return cerrar(p.id, false, "sin_producto");
  const r = await co("/orders", {
    method: "POST",
    body: JSON.stringify({
      items: [{ catalog_item_id: pk.co_product_id, quantity: 1, target_payload: target(p.id_jugador) }],
      note: `pedido ${p.id}`,
    }),
  }, `pedido-${p.id}`);
  if (r.status === 200 || r.status === 201) {
    const o = r.body.order;
    await admin.from("pedidos").update({ co_order_id: o.id, co_reference: o.reference_code }).eq("id", p.id);
    return;
  }
  const code = r.body?.error?.code;
  // Errores definitivos: se devuelve el saldo al cliente. El resto (401/403/429/5xx) queda pendiente y se reintenta.
  if ([400, 404, 409, 422].includes(r.status)) return cerrar(p.id, false, code || `http_${r.status}`);
  await admin.from("pedidos").update({ motivo: code || `http_${r.status}` }).eq("id", p.id);
}

// Consulta el estado real (fuente de verdad) y cierra el pedido si ya terminó.
async function revisar(p: any) {
  if (!p.co_order_id) return enviar(p);
  const r = await co(`/orders/${p.co_order_id}`);
  const o = r.body?.order;
  if (!o) return;
  if (o.status === "completed") return cerrar(p.id, true, null);
  if (o.status === "failed" || o.status === "cancelled") return cerrar(p.id, false, o.failure?.code || o.status);
}

async function webhook(req: Request, raw: string, sig: string) {
  const ts = req.headers.get("x-centralone-timestamp") || "";
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return json({ error: "timestamp" }, 400);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env("CO_WEBHOOK_SECRET")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${raw}`)));
  const esperada = "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  let dif = esperada.length ^ sig.length;
  for (let i = 0; i < esperada.length; i++) dif |= esperada.charCodeAt(i) ^ (sig.charCodeAt(i) || 0);
  if (dif !== 0) return json({ error: "firma" }, 401);
  const ref = JSON.parse(raw)?.order?.reference_code;
  if (ref) {
    const { data } = await admin.from("pedidos").select("id,diamantes,id_jugador,co_order_id")
      .eq("co_reference", ref).eq("estado", "pendiente").maybeSingle();
    if (data) await revisar(data);   // no confía en el aviso: relee la orden en la API
  }
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const raw = await req.text();
  const sig = req.headers.get("x-centralone-signature");
  if (sig) return webhook(req, raw, sig);

  const auth = req.headers.get("Authorization") || "";
  const uc = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await uc.auth.getUser();
  if (!user) return json({ ok: false, error: "sesion" }, 401);
  const { data: perf } = await admin.from("perfiles").select("es_admin").eq("id", user.id).single();
  const a = JSON.parse(raw || "{}");

  try {
    if (a.action === "validate" || a.action === "buy") {
      if (!/^[0-9]{5,15}$/.test(String(a.id))) return json({ ok: false, error: "id" });
      const { data: pk } = await admin.from("paquetes").select("co_product_id").eq("diamantes", a.diamantes).eq("activo", true).single();
      if (!pk?.co_product_id) return a.action === "validate" ? json({ ok: true, status: "unverified" }) : json({ ok: false, error: "paquete" });

      if (a.action === "validate") {
        const r = await co("/player/validate", { method: "POST", body: JSON.stringify({ product_id: pk.co_product_id, target_payload: target(String(a.id)) }) });
        return json({ ok: true, status: r.body?.status || "unverified", name: r.body?.player?.name || null });
      }
      // Compra: descuenta saldo con tu RPC (precio de la tabla) y envía a Central One
      const { data: pid, error } = await uc.rpc("comprar", { p_diamantes: a.diamantes, p_id: String(a.id) });
      if (error) return json({ ok: false, error: error.message });
      const { data: ped } = await admin.from("pedidos").select("id,diamantes,id_jugador,co_order_id").eq("id", pid).single();
      try { await enviar(ped); } catch { /* queda pendiente; el sync lo reintenta con la misma Idempotency-Key */ }
      fondo(vigilarSaldo());   // si el saldo en Central One quedó bajo, te avisa
      return json({ ok: true });
    }

    // Aviso al admin cuando alguien se inscribe a un torneo (Telegram y/o Discord). Solo se envía una vez por inscripción.
    if (a.action === "aviso") {
      const { data: ins } = await admin.from("inscripciones")
        .select("id,usuario,equipo,monto,metodo,referencia,cobro,estado,torneos(titulo,moneda,fecha),inscripcion_jugadores(nombre,id_jugador)")
        .eq("id", a.id).single();
      if (!ins || ins.usuario !== user.id) return json({ ok: true });
      const { data: marca } = await admin.from("inscripciones").update({ avisado: true }).eq("id", ins.id).eq("avisado", false).select("id");
      if (!marca?.length) return json({ ok: true });   // ya se avisó
      const t: any = ins.torneos;
      const dinero = (n: number) => t?.moneda === "USDT" ? `${n} USDT` : `$${Number(n).toLocaleString("es-AR")}`;
      const jug = (ins.inscripcion_jugadores || []).map((j: any) => `${j.nombre} (${j.id_jugador})`).join(", ");
      const lineas = [
        `🎮 Nueva inscripción: ${t?.titulo}`,
        `${ins.equipo ? ins.equipo + " · " : ""}${jug}`,
        Number(ins.monto) > 0
          ? `💸 ${dinero(ins.monto)} por ${ins.metodo === "binance" ? "Binance" : "Mercado Pago"} · comprobante: ${/^foto:/.test(ins.referencia || "") ? "📷 foto (verla en el panel)" : ins.referencia} · ${ins.estado === "pendiente" ? "PENDIENTE de aprobar" : ins.estado}`
          : "Inscripción gratis (confirmada)",
        ...(ins.cobro ? [`Cobra en: ${ins.cobro}`] : []),
        ...(Deno.env.get("SITE_URL") ? [`Panel: ${Deno.env.get("SITE_URL")}/admin.html`] : []),
      ];
      await notificar(lineas, "XITERKING Torneos");
      return json({ ok: true });
    }

    // Aviso al admin cuando alguien pide la devolución por cambio de horario. Solo se envía una vez por pedido.
    if (a.action === "aviso_devolucion") {
      if (!/^\d+$/.test(String(a.id))) return json({ ok: true });
      const { data: s } = await admin.from("solicitudes_devolucion")
        .select("id,usuario,motivo,inscripciones(equipo,monto,metodo,torneos(titulo,moneda)),perfiles(nombre,email)").eq("id", a.id).single();
      if (!s || s.usuario !== user.id) return json({ ok: true });
      const { data: marca } = await admin.from("solicitudes_devolucion").update({ avisado: true }).eq("id", s.id).eq("avisado", false).select("id");
      if (!marca?.length) return json({ ok: true });
      const i: any = s.inscripciones, p: any = s.perfiles, t: any = i?.torneos;
      await notificar([
        "↩️ Pedido de devolución (cambio de horario)",
        `${p?.nombre || "Sin nombre"} (${p?.email || "sin email"})`,
        `Torneo: ${t?.titulo} · ${i?.equipo ? i.equipo + " · " : ""}pagó ${t?.moneda === "USDT" ? i?.monto + " USDT" : "$" + Number(i?.monto).toLocaleString("es-AR")} por ${i?.metodo === "binance" ? "Binance" : "Mercado Pago"}`,
        ...panelUrl(),
      ], "XITERKING Devoluciones");
      return json({ ok: true });
    }

    // Aviso al admin cuando alguien carga saldo (queda pendiente de aprobar)
    if (a.action === "aviso_deposito") {
      if (/^\d+$/.test(String(a.id))) await avisarDeposito(Number(a.id), user.id);
      return json({ ok: true });
    }

    if (a.action === "sync") {
      let q = admin.from("pedidos").select("id,diamantes,id_jugador,co_order_id").eq("estado", "pendiente").limit(20);
      if (!perf?.es_admin) q = q.eq("usuario", user.id);
      const { data } = await q;
      for (const p of data || []) { try { await revisar(p); } catch { /* sigue con el próximo */ } }
      if (perf?.es_admin) fondo(vigilarSaldo());
      // Red de seguridad: si algún aviso de carga de saldo no salió, se envía ahora
      let qd = admin.from("depositos").select("id").eq("estado", "pendiente").eq("avisado", false).limit(10);
      if (!perf?.es_admin) qd = qd.eq("usuario", user.id);
      const { data: dps } = await qd;
      for (const d of dps || []) { try { await avisarDeposito(d.id); } catch { /* sigue */ } }
      return json({ ok: true });
    }

    if (a.action === "balance" && perf?.es_admin) {
      const b = await co("/balance");
      const disp = Number(b.body?.available_balance);
      return json({ ok: true, disponible: Number.isFinite(disp) ? disp : null, minimo: MIN_CO(), bajo: Number.isFinite(disp) && disp < MIN_CO() });
    }

    if (a.action === "catalog" && perf?.es_admin) {
      const [c, b] = await Promise.all([co("/catalog"), co("/balance")]);
      return json({ ok: true, items: c.body?.items || [], balance: b.body });
    }
  } catch {
    return json({ ok: false, error: "red" });
  }
  return json({ ok: false, error: "accion" }, 400);
});