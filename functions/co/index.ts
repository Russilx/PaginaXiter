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
      return json({ ok: true });
    }

    if (a.action === "sync") {
      let q = admin.from("pedidos").select("id,diamantes,id_jugador,co_order_id").eq("estado", "pendiente").limit(20);
      if (!perf?.es_admin) q = q.eq("usuario", user.id);
      const { data } = await q;
      for (const p of data || []) { try { await revisar(p); } catch { /* sigue con el próximo */ } }
      return json({ ok: true });
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