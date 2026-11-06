// ===== CONFIGURACIÓN =====
// Clave anon/publishable: es pública por diseño (la seguridad la dan las reglas de la base).
// NUNCA pegues acá la clave "service_role".
const SUPABASE_URL = "https://udmumufzdkvnmmeicxup.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_2pVxvjt8CNZshO93ppGotg_HEeGbKL4";

// Datos donde te pagan los clientes
const PAGOS = {
  mp: { alias: "Elestu2.0", titular: "Esteban Manuel San Martin" },
  // Cotización para cobrar en pesos o en USDT según elija el cliente (pesos por 1 USDT).
  // ¡ACTUALIZALA cuando cambie el dólar! Los montos que ve el cliente se calculan con este número.
  tasaUSDT: 1610,
  binance: {
    payId: "847835648",
    nota: "USDT (Binance Pay)",
    qr: "assets/binance-qr.png"
  }
};

// ===== LÓGICA DEL SITIO =====
// Fondo: trama estática (sin partículas)
(function(){const fx=document.createElement("div");fx.id="fx";document.body.prepend(fx);})();

// Cantidades de los paquetes
const io=new IntersectionObserver(es=>es.forEach(e=>{
  if(!e.isIntersecting)return;
  e.target.classList.add("in");
  e.target.querySelectorAll("[data-count]").forEach(contar);
  io.unobserve(e.target);
}),{threshold:.15});
function observar(){document.querySelectorAll(".rv:not(.in)").forEach(el=>io.observe(el));}
function contar(el){ el.firstChild.nodeValue = (+el.dataset.count).toLocaleString("es-AR"); }
function toast(msg){
  let t=document.getElementById("toast");
  if(!t){t=document.createElement("div");t.id="toast";document.body.appendChild(t);}
  t.textContent=msg;t.classList.add("show");
  clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove("show"),2200);
}
observar();

// ---- Cuentas y saldo (Supabase) ----
// ---- Cobro: el cliente elige Mercado Pago o Binance Pay ----
const Cobro = {
  nombre: { mercadopago: "Mercado Pago", binance: "Binance Pay" },
  monedaDe: m => m === "binance" ? "USDT" : "ARS",
  // Pasa un monto de la moneda del torneo a la moneda del método elegido (redondea hacia arriba)
  convertir(monto, monedaTorneo, metodo){
    const n = Number(monto) || 0, d = Cobro.monedaDe(metodo), o = monedaTorneo === "USDT" ? "USDT" : "ARS";
    if(!metodo || d === o) return n;
    return d === "USDT" ? Math.ceil(n / PAGOS.tasaUSDT * 100) / 100 : Math.ceil(n * PAGOS.tasaUSDT / 10) * 10;
  },
  texto: (n, metodo) => Cobro.monedaDe(metodo) === "USDT" ? Number(n).toLocaleString("es-AR",{maximumFractionDigits:2}) + " USDT" : "$" + Number(n).toLocaleString("es-AR")
};
// ---- Comprobante de pago con foto (en vez de escribir un número) ----
const Comprobante = {
  campo: id => `<div class="field" style="margin-top:12px"><label for="${id}">Foto del comprobante</label><input id="${id}" type="file" accept="image/png,image/jpeg,image/webp"><small style="display:block;color:var(--muted);margin-top:6px">Subí la captura o foto del pago (PNG, JPG o WEBP, hasta 5 MB). Tiene que verse el monto y el número de operación.</small></div>`,
  validar(f){
    if(!f) return "Subí la foto del comprobante del pago.";
    if(!/^image\/(png|jpe?g|webp)$/.test(f.type)) return "La foto tiene que ser PNG, JPG o WEBP.";
    if(f.size > 5 * 1024 * 1024) return "La foto pesa más de 5 MB.";
    return "";
  },
  async hash(f){
    const b = await crypto.subtle.digest("SHA-256", await f.arrayBuffer());
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,"0")).join("").slice(0,32);
  },
  // Sube la foto y devuelve { ref, ruta }. "ref" es la huella de la imagen: así la misma foto no se puede usar dos veces.
  async subir(f){
    const ref = "foto:" + await Comprobante.hash(f);
    const ext = f.type.split("/")[1].replace("jpeg","jpg");
    const ruta = Auth.actual().id + "/" + Date.now() + "-" + ref.slice(5,13) + "." + ext;
    const { error } = await sb.storage.from("comprobantes").upload(ruta, f, { contentType: f.type });
    if(error){ Auth.detalle = error.message; throw new Error("subida"); }
    return { ref, ruta };
  },
  adjuntar: (tipo, id, ruta) => sb.rpc("adjuntar_comprobante", { p_tipo: tipo, p_id: id, p_ruta: ruta }),
  texto: r => /^foto:/.test(r || "") ? "📷 Foto" : esc(r || "")
};
const MONEDA = " USDT";
const fmt = n => Number(n).toLocaleString("es-AR",{minimumFractionDigits:2,maximumFractionDigits:4}) + MONEDA;
const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const Auth = {
  u: null,
  async cargarPerfil(){
    const { data:{ session } } = await sb.auth.getSession();
    if(!session){ Auth.u = null; return; }
    const { data } = await sb.from("perfiles").select("nombre,email,saldo,es_admin").eq("id",session.user.id).single();
    Auth.u = data ? { id:session.user.id, ...data } : null;
  },
  init(){ return Auth.cargarPerfil().catch(()=>{ Auth.u = null }); },
  actual(){ return Auth.u },
  async registrar(nombre,email,pass){
    const { data, error } = await sb.auth.signUp({ email:email.trim(), password:pass, options:{ data:{ nombre:nombre.trim() } } });
    if(error){ Auth.detalle = error.message; throw new Error(/registered/i.test(error.message) ? "existe" : "red"); }
    if(data.user && data.user.identities && !data.user.identities.length) throw new Error("existe");
    if(!data.session) throw new Error("confirmar");
  },
  async entrar(email,pass){
    const { error } = await sb.auth.signInWithPassword({ email:email.trim(), password:pass });
    if(error) Auth.detalle = error.message;
    if(error) throw new Error(/confirm/i.test(error.message) ? "sinconfirmar" : /invalid|credentials/i.test(error.message) ? "datos" : "red");
  },
  async verificar(email,codigo){
    const { error } = await sb.auth.verifyOtp({ email:email.trim(), token:codigo.trim(), type:"signup" });
    if(error){ Auth.detalle = error.message; throw new Error(/expired|invalid/i.test(error.message) ? "codigo" : "red"); }
  },
  async reenviar(email){
    const { error } = await sb.auth.resend({ type:"signup", email:email.trim() });
    if(error){ Auth.detalle = error.message; throw new Error(/second|rate|limit/i.test(error.message) ? "espera" : "red"); }
  },
  // Recuperar contraseña con código (igual que la confirmación de email)
  async recuperar(email){
    const { error } = await sb.auth.resetPasswordForEmail(email.trim());
    if(error){ Auth.detalle = error.message; throw new Error(/second|rate|limit/i.test(error.message) ? "espera" : "red"); }
  },
  async nuevaPass(email,codigo,pass){
    const v = await sb.auth.verifyOtp({ email:email.trim(), token:codigo.trim(), type:"recovery" });
    if(v.error){ Auth.detalle = v.error.message; throw new Error(/expired|invalid/i.test(v.error.message) ? "codigo" : "red"); }
    const { error } = await sb.auth.updateUser({ password:pass });
    if(error){ Auth.detalle = error.message; throw new Error(/different|same/i.test(error.message) ? "igual" : /weak|short|least|character/i.test(error.message) ? "debil" : "red"); }
  },
  async salir(){ await sb.auth.signOut(); location.href = "index.html"; },
  renderAcct(){
    const box = document.getElementById("acct"); if(!box) return;
    const u = Auth.u;
    box.innerHTML = u
      ? `${u.es_admin ? '<a class="pill plain" href="admin.html">Admin</a>' : ""}<a class="pill plain" href="mis-torneos.html">Mis torneos</a><a class="pill" href="free-fire-latam.html">Saldo: <b data-saldo></b></a><div class="user"><span class="av">${esc((u.nombre.trim().charAt(0)||"?").toUpperCase())}</span><b>${esc(u.nombre)}</b><button type="button" id="salir">Cerrar sesión</button></div>`
      : `<a class="pill plain" href="cuenta.html">Ingresar</a><a class="btn sm" href="cuenta.html?modo=registro">Crear cuenta</a>`;
    const b = document.getElementById("salir"); if(b) b.onclick = Auth.salir;
  }
};
const Saldo = {
  get(){ return Auth.u ? Number(Auth.u.saldo) : 0 },
  async refrescar(anim){ await Auth.cargarPerfil(); Saldo.render(anim); },
  render(anim){
    document.querySelectorAll("[data-saldo]").forEach(el=>el.textContent=fmt(Saldo.get()));
    if(anim) document.querySelectorAll(".balance").forEach(b=>{b.classList.remove("bump");void b.offsetWidth;b.classList.add("bump")});
  }
};
Auth.listo = Auth.init().then(()=>{ Auth.renderAcct(); Saldo.render(); });
// Recordatorios y bajas por check-in: se procesan al abrir cualquier página
Auth.listo = Auth.listo.then(()=>sb.rpc("procesar_checkins")).then(()=>{},()=>{});
// Aviso cuando se libera un lugar en un torneo de la lista de espera
Auth.listo.then(async()=>{
  if(!Auth.u) return;
  const { data } = await sb.from("notificaciones").select("id,mensaje,enlace").eq("leida",false).order("creado",{ascending:false}).limit(3);
  if(!data || !data.length) return;
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9000;background:#e10600;color:#fff;padding:12px 16px;text-align:center;font-weight:700;font-size:.9rem";
  d.innerHTML = data.map(n => esc(n.mensaje)).join("<br>") + ' <a href="' + esc(/^[a-z0-9-]+\.html(#[\w-]*)?$/i.test(data[0].enlace || "") ? data[0].enlace : "index.html") + '" style="color:#fff;text-decoration:underline;margin-left:8px">Ver</a><button type="button" style="margin-left:10px;background:#0004;border:0;color:#fff;border-radius:8px;padding:4px 10px;cursor:pointer">✕</button>';
  d.querySelector("button").onclick = async()=>{ d.remove(); await sb.rpc("marcar_notificaciones_leidas"); };
  document.body.appendChild(d);
});

// ===== Mejoras de uso =====
// Enlace para saltar al contenido (teclado y lectores de pantalla)
(function(){
  const s=document.createElement("a"); s.href="#contenido"; s.className="skip"; s.textContent="Saltar al contenido";
  document.body.prepend(s);
  const w=document.querySelector(".wrap"); if(w && !w.id) w.id="contenido";
})();
// "Cargando…" con efecto de carga en lugar de texto quieto
(function(){
  const marcar=()=>document.querySelectorAll(".tvacio").forEach(e=>e.classList.toggle("cargando",/^\s*Cargando/.test(e.textContent)));
  let t; new MutationObserver(()=>{clearTimeout(t);t=setTimeout(marcar,30)}).observe(document.body,{childList:true,subtree:true,characterData:true});
  marcar();
})();
// Barra de navegación inferior en celulares
Auth.listo.then(()=>{
  const p=location.pathname.split("/").pop()||"index.html";
  if(p==="admin.html") return;
  const ic=d=>'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+d+'</svg>';
  const logged=!!Auth.actual();
  const items=[
    ["index.html","Inicio",ic('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),p==="index.html"],
    ["free-fire-latam.html","Recargas",ic('<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20"/>'),p==="free-fire-latam.html"],
    ["index.html#torneos","Torneos",ic('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),p==="resultados.html"],
    ["index.html#ranking","Ranking",ic('<path d="M5 21V11M12 21V4M19 21v-7"/>'),false],
    logged?["mis-torneos.html","Mis torneos",ic('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),p==="mis-torneos.html"]
          :["cuenta.html","Ingresar",ic('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),p==="cuenta.html"]
  ];
  const n=document.createElement("nav"); n.className="tabbar"; n.setAttribute("aria-label","Navegación principal");
  n.innerHTML=items.map(x=>'<a href="'+x[0]+'"'+(x[3]?' class="on" aria-current="page"':'')+'>'+x[2]+'<span>'+x[1]+'</span></a>').join("");
  document.body.appendChild(n);
});

// ===== COMUNIDAD: pegá acá tus links (si dejás uno vacío, ese botón no aparece) =====
const COMUNIDAD = {
  discord: "",    // ej: "https://discord.gg/tuinvitacion"
  whatsapp: ""    // ej: "https://chat.whatsapp.com/tuenlace"
};
(function(){
  const box = document.getElementById("comunidad"); if(!box) return;
  const ok = u => /^https:\/\//.test(u || "");
  const b = [];
  if(ok(COMUNIDAD.discord)) b.push('<a class="com-btn dc" href="' + esc(COMUNIDAD.discord) + '" target="_blank" rel="noopener"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.2.5a18 18 0 0 0-6.4 0L8.6 3a19.8 19.8 0 0 0-4.9 1.4C.6 9 0 13.5.3 18a20 20 0 0 0 6 3l1.3-2.1c-.7-.3-1.4-.6-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.300.7-2 1L18 21a20 20 0 0 0 6-3c.4-5.200-.7-9.700-3.700-13.600zM8.500 15.300c-1.200 0-2.100-1.100-2.100-2.400s.9-2.400 2.100-2.400 2.100 1.100 2.100 2.400-.9 2.400-2.100 2.400zm7 0c-1.200 0-2.100-1.100-2.100-2.400s.9-2.400 2.100-2.400 2.100 1.100 2.100 2.400-.9 2.400-2.100 2.400z"/></svg>Unirme al Discord</a>');
  if(ok(COMUNIDAD.whatsapp)) b.push('<a class="com-btn wp" href="' + esc(COMUNIDAD.whatsapp) + '" target="_blank" rel="noopener"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 20.5l1.7-5.4A8.4 8.4 0 1 1 21 11.5z"/></svg>Comunidad de WhatsApp</a>');
  if(!b.length) return;
  box.innerHTML = '<div class="com"><div class="com-t"><b>Sumate a la comunidad XITERKING</b><span>Enterate primero de los torneos, premios y novedades, y charlá con otros jugadores.</span></div><div class="com-b">' + b.join("") + '</div></div>';
})();

// ===== ASISTENTE DE IA (responde por la Edge Function "asistente") =====
Auth.listo.then(()=>{
  const p = location.pathname.split("/").pop() || "index.html";
  if(p === "admin.html") return;
  const fab = document.createElement("button"); fab.type = "button"; fab.className = "ia-fab"; fab.setAttribute("aria-label","Abrir el asistente de IA");
  fab.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.500 9.500l4.700-1.800z"/><path d="M19 15l.8 2.200L22 18l-2.200.8L19 21l-.8-2.200L16 18l2.200-.8z"/></svg><span>Preguntale a la IA</span>';
  const w = document.createElement("div"); w.className = "ia-box"; w.hidden = true; w.setAttribute("role","dialog"); w.setAttribute("aria-label","Asistente de IA");
  w.innerHTML = '<div class="ia-h"><b>Asistente XITERKING</b><button type="button" class="ia-x" aria-label="Cerrar">✕</button></div><div class="ia-m" aria-live="polite"></div><form class="ia-f"><input maxlength="1000" placeholder="Escribí tu pregunta…" autocomplete="off" aria-label="Tu pregunta"><button class="btn sm" type="submit">Enviar</button></form><small class="ia-n">Es una IA y puede equivocarse. No escribas contraseñas ni datos personales. Para pagos y reembolsos, confirmá con soporte.</small>';
  document.body.append(fab, w);
  const m = w.querySelector(".ia-m"), f = w.querySelector("form"), inp = w.querySelector("input"), H = [];
  const poner = (rol, txt) => { const d = document.createElement("div"); d.className = "ia-b " + rol; d.textContent = txt; m.appendChild(d); m.scrollTop = m.scrollHeight; return d; };
  poner("bot", "¡Hola! Soy el asistente de XITERKING. Preguntame lo que quieras: recargas, torneos, reglas o cualquier otra cosa.");
  const abrir = v => { w.hidden = !v; fab.classList.toggle("on", v); if(v) inp.focus(); };
  fab.onclick = () => abrir(w.hidden);
  w.querySelector(".ia-x").onclick = () => abrir(false);
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const q = inp.value.trim(); if(!q) return;
    if(!Auth.actual()){ const d = poner("bot", "Para usar el asistente tenés que "); const a = document.createElement("a"); a.href = "cuenta.html?volver=" + encodeURIComponent(p); a.textContent = "ingresar a tu cuenta"; d.appendChild(a); d.append("."); return; }
    inp.value = ""; poner("yo", q); H.push({ role: "user", content: q });
    const esp = poner("bot", "Escribiendo…"); inp.disabled = true; f.querySelector("button").disabled = true;
    let txt = "No pude responder ahora. Probá de nuevo en un rato.";
    try{
      const r = await sb.functions.invoke("asistente", { body: { mensajes: H.slice(-10) } });
      if(r.data && r.data.ok && r.data.texto) txt = r.data.texto;
      else if(r.data && r.data.error === "ocupado") txt = "Hay muchas consultas en este momento. Probá de nuevo en un minuto.";
      else if(r.data && r.data.error === "limite") txt = "Llegaste al límite de preguntas de hoy. Mañana podés seguir, o escribinos por soporte.";
    }catch(_){}
    esp.textContent = txt; H.push({ role: "assistant", content: txt });
    inp.disabled = false; f.querySelector("button").disabled = false; inp.focus(); m.scrollTop = m.scrollHeight;
  });
});
/* ===== Llaves (cuartos, semifinal, final) · dibujo compartido ===== */
const FASES_LLAVE = { octavos:"Octavos de final", cuartos:"Cuartos de final", semifinal:"Semifinales", final:"Final", tercer_puesto:"3er puesto" };
const FASE_UNA = { octavos:"octavos", cuartos:"cuartos de final", semifinal:"la semifinal", final:"la final", tercer_puesto:"el partido por el 3er puesto" };
const RANGO_FASE = { octavos:1, cuartos:2, semifinal:3, tercer_puesto:4, final:5 };
// admin=true agrega, en cada partido listo para jugar, el marcador y los botones "Gana ..."
function llavesHtml(L, admin){
  if(!L || !L.length) return "";
  const eq = (id, nom, p, gan) => `<div class="lk-t${gan === id && id ? " gana" : (gan && id ? " pierde" : "")}"><span>${id ? esc(nom) : "Por definir"}</span>${p !== null && p !== undefined ? `<b>${p}</b>` : ""}</div>`;
  const partido = m => {
    const bye = m.a_id && !m.b_id && m.ganador && m.fase !== "final" && m.fase !== "tercer_puesto" && m.ganador === m.a_id;
    const listo = admin && m.a_id && m.b_id;
    return `<div class="lk-m${bye ? " bye" : ""}">${eq(m.a_id, m.a_nombre, m.puntaje_a, m.ganador)}${bye ? '<div class="lk-t"><span class="lk-bye">Pasa directo</span></div>' : eq(m.b_id, m.b_nombre, m.puntaje_b, m.ganador)}
      ${listo ? `<div class="lk-adm" data-lkm="${m.id}"><input inputmode="numeric" data-sa placeholder="A" value="${m.puntaje_a ?? ""}"><input inputmode="numeric" data-sb placeholder="B" value="${m.puntaje_b ?? ""}">
        <button class="btn sm${m.ganador === m.a_id ? "" : " ghost"}" type="button" data-lkg="${m.a_id}">Gana ${esc(m.a_nombre)}</button>
        <button class="btn sm${m.ganador === m.b_id ? "" : " ghost"}" type="button" data-lkg="${m.b_id}">Gana ${esc(m.b_nombre)}</button></div>` : ""}</div>`;
  };
  const cols = ["octavos","cuartos","semifinal","final"].filter(f => L.some(m => m.fase === f))
    .map(f => `<div class="lk-c"><h4>${FASES_LLAVE[f]}</h4>${L.filter(m => m.fase === f).map(partido).join("")}</div>`).join("");
  const t3 = L.filter(m => m.fase === "tercer_puesto");
  const camp = L.find(m => m.fase === "final" && m.ganador);
  return `<div class="lk">${camp ? `<div class="lk-camp">🏆 Campeón: <b>${esc(camp.ganador === camp.a_id ? camp.a_nombre : camp.b_nombre)}</b></div>` : ""}<div class="lk-scroll"><div class="lk-cols">${cols}</div></div>${t3.length ? `<div class="lk-3"><h4>${FASES_LLAVE.tercer_puesto}</h4>${t3.map(partido).join("")}</div>` : ""}</div>`;
}
// Estado de un equipo dentro del cuadro: "Seguís en cuartos de final vs X", "Eliminado en la semifinal", "Campeón"
function estadoEnLlave(L, insId){
  const mios = (L || []).filter(m => m.a_id === insId || m.b_id === insId);
  if(!mios.length) return null;
  const m = mios.sort((x, y) => RANGO_FASE[y.fase] - RANGO_FASE[x.fase])[0];
  const rival = m.a_id === insId ? m.b_nombre : m.a_nombre;
  if(m.ganador === insId) return m.fase === "final" ? { t:"🏆 ¡Sos el campeón!", ok:true } : m.fase === "tercer_puesto" ? { t:"🥉 Terminaste 3º", ok:true } : { t:"✅ Pasaste de fase", ok:true };
  if(m.ganador) return { t: m.fase === "final" ? "🥈 Terminaste 2º" : "❌ Quedaste eliminado en " + FASE_UNA[m.fase], ok:false };
  return { t: "⚔️ Seguís en " + FASE_UNA[m.fase] + (rival ? " · rival: " + rival : " · rival por definir"), ok:true };
}