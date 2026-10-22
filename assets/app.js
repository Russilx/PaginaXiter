// ============================================================
// CONFIGURACIÓN (antes config.js)
// ============================================================
// 1) Supabase > Project Settings > API: copiá la "Project URL" y la clave "anon public".
//    La clave anon es pública por diseño; la seguridad la dan las reglas de schema.sql.
//    NUNCA pegues acá la clave "service_role".
const SUPABASE_URL = "https://udmumufzdkvnmmeicxup.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_2pVxvjt8CNZshO93ppGotg_HEeGbKL4";

// 2) Datos donde te pagan los clientes
const PAGOS = {
  mp: { alias: "Elestu2.0", titular: "Esteban Manuel San Martin" },
  binance: {
    payId: "847835648",
    nota: "USDT (Binance Pay)",
    // Imagen de tu QR: en la app de Binance andá a Pay > Recibir, guardá el QR,
    // ponelo en esta carpeta con este nombre (png) y se muestra solo.
    qr: "assets/binance-qr.png"
  }
};

// ============================================================
// LÓGICA DEL SITIO (antes script.js)
// ============================================================
// Fondo: partículas y brasas
(function(){
  const fx=document.createElement("div");fx.id="fx";
  // Brasas que suben (igual que en la pantalla de carga)
  const cols=["#ff4a1a","#e10600","#ff7a2e"];
  for(let i=0;i<22;i++){
    const b=document.createElement("span"),z=2+Math.random()*3,c=cols[i%3];
    b.className="em";
    b.style.cssText=`left:${Math.random()*100}%;width:${z}px;height:${z}px;background:${c};box-shadow:0 0 8px ${c};animation-duration:${6+Math.random()*7}s;animation-delay:-${(Math.random()*10).toFixed(1)}s`;
    fx.appendChild(b);
  }
  for(let i=0;i<28;i++){
    const d=document.createElement("i"),s=2+Math.random()*2.5;
    d.style.cssText=`left:${Math.random()*100}%;top:${Math.random()*92}%;width:${s}px;height:${s}px;animation-duration:${3+Math.random()*5}s;animation-delay:${-Math.random()*6}s`;
    fx.appendChild(d);
  }
  document.body.prepend(fx);
})();

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
  async salir(){ await sb.auth.signOut(); location.href = "index.html"; },
  renderAcct(){
    const box = document.getElementById("acct"); if(!box) return;
    const u = Auth.u;
    box.innerHTML = u
      ? `${u.es_admin ? '<a class="pill plain" href="admin.html">Admin</a>' : ""}<a class="pill" href="free-fire-latam.html">Saldo: <b data-saldo></b></a><div class="user"><span class="av">${esc((u.nombre.trim().charAt(0)||"?").toUpperCase())}</span><b>${esc(u.nombre)}</b><button type="button" id="salir">Cerrar sesión</button></div>`
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