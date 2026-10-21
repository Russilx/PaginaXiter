-- ============================================================
-- INSTALACIÓN COMPLETA (Supabase > SQL Editor > Run)
-- Contiene: 1) esquema base  2) migración Central One  3) precios admin
-- Si ya ejecutaste los 3 archivos anteriores, NO hace falta correr esto de nuevo.
-- ============================================================

-- ===== 1) ESQUEMA BASE =====
-- Pegá TODO esto en Supabase > SQL Editor > Run

create table perfiles (
  id uuid primary key references auth.users on delete cascade,
  nombre text not null default '',
  email text,
  saldo numeric(12,2) not null default 0 check (saldo >= 0),
  es_admin boolean not null default false,
  creado timestamptz not null default now()
);
create table paquetes (
  diamantes int primary key,
  precio numeric(12,2) not null check (precio > 0),
  etiqueta text,
  activo boolean not null default true
);
create table depositos (
  id bigint generated always as identity primary key,
  usuario uuid not null references perfiles(id),
  metodo text not null check (metodo in ('mercadopago','binance')),
  monto numeric(12,2) not null check (monto > 0),
  referencia text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente','aprobado','rechazado')),
  acreditado numeric(12,2),
  creado timestamptz not null default now()
);
-- el mismo comprobante no se puede usar dos veces
create unique index depositos_ref_unica on depositos (metodo, lower(referencia));
create table pedidos (
  id bigint generated always as identity primary key,
  usuario uuid not null references perfiles(id),
  diamantes int not null,
  precio numeric(12,2) not null,
  id_jugador text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente','entregado','rechazado')),
  creado timestamptz not null default now()
);

-- perfil automático al registrarse
create function crear_perfil() returns trigger language plpgsql security definer set search_path = public as $f$
begin
  insert into perfiles (id, nombre, email) values (new.id, coalesce(new.raw_user_meta_data->>'nombre',''), new.email);
  return new;
end $f$;
create trigger al_registrarse after insert on auth.users for each row execute function crear_perfil();

create function soy_admin() returns boolean language sql security definer stable set search_path = public as $f$
  select coalesce((select es_admin from perfiles where id = auth.uid()), false)
$f$;

-- seguridad: nadie escribe directo en las tablas, solo a través de las funciones de abajo
alter table perfiles enable row level security;
alter table paquetes enable row level security;
alter table depositos enable row level security;
alter table pedidos enable row level security;
revoke all on perfiles, paquetes, depositos, pedidos from anon, authenticated;
grant select on perfiles, depositos, pedidos to authenticated;
grant select on paquetes to anon, authenticated;
create policy ver_perfil on perfiles for select using (id = auth.uid() or soy_admin());
create policy ver_paquetes on paquetes for select using (activo);
create policy ver_depositos on depositos for select using (usuario = auth.uid() or soy_admin());
create policy ver_pedidos on pedidos for select using (usuario = auth.uid() or soy_admin());

-- el cliente avisa que pagó (queda pendiente hasta que lo apruebes)
create function pedir_deposito(p_metodo text, p_monto numeric, p_ref text) returns bigint language plpgsql security definer set search_path = public as $f$
declare v_id bigint;
begin
  if auth.uid() is null then raise exception 'sesion'; end if;
  if length(trim(p_ref)) < 4 or length(p_ref) > 200 then raise exception 'referencia'; end if;
  insert into depositos (usuario, metodo, monto, referencia) values (auth.uid(), p_metodo, p_monto, trim(p_ref)) returning id into v_id;
  return v_id;
exception when unique_violation then raise exception 'duplicado';
end $f$;

-- compra: el precio sale de la tabla paquetes (no del navegador) y descuenta el saldo de forma atómica
create function comprar(p_diamantes int, p_id text) returns bigint language plpgsql security definer set search_path = public as $f$
declare v_precio numeric; v_saldo numeric; v_pedido bigint;
begin
  if auth.uid() is null then raise exception 'sesion'; end if;
  if p_id !~ '^[0-9]{5,15}$' then raise exception 'id'; end if;
  select precio into v_precio from paquetes where diamantes = p_diamantes and activo;
  if v_precio is null then raise exception 'paquete'; end if;
  select saldo into v_saldo from perfiles where id = auth.uid() for update;
  if v_saldo < v_precio then raise exception 'saldo'; end if;
  update perfiles set saldo = saldo - v_precio where id = auth.uid();
  insert into pedidos (usuario, diamantes, precio, id_jugador) values (auth.uid(), p_diamantes, v_precio, p_id) returning id into v_pedido;
  return v_pedido;
end $f$;

-- solo admin: aprobar o rechazar una carga de saldo
create function resolver_deposito(p_id bigint, p_aprobar boolean, p_credito numeric) returns void language plpgsql security definer set search_path = public as $f$
declare v_dep depositos%rowtype;
begin
  if not soy_admin() then raise exception 'permiso'; end if;
  select * into v_dep from depositos where id = p_id and estado = 'pendiente' for update;
  if not found then raise exception 'resuelto'; end if;
  if p_aprobar then
    if p_credito is null or p_credito <= 0 then raise exception 'monto'; end if;
    update perfiles set saldo = saldo + p_credito where id = v_dep.usuario;
    update depositos set estado = 'aprobado', acreditado = p_credito where id = p_id;
  else
    update depositos set estado = 'rechazado' where id = p_id;
  end if;
end $f$;

-- solo admin: marcar un pedido como entregado, o rechazarlo y devolver el saldo
create function resolver_pedido(p_id bigint, p_ok boolean) returns void language plpgsql security definer set search_path = public as $f$
declare v_ped pedidos%rowtype;
begin
  if not soy_admin() then raise exception 'permiso'; end if;
  select * into v_ped from pedidos where id = p_id and estado = 'pendiente' for update;
  if not found then raise exception 'resuelto'; end if;
  if p_ok then
    update pedidos set estado = 'entregado' where id = p_id;
  else
    update perfiles set saldo = saldo + v_ped.precio where id = v_ped.usuario;
    update pedidos set estado = 'rechazado' where id = p_id;
  end if;
end $f$;

revoke execute on function pedir_deposito(text,numeric,text), comprar(int,text), resolver_deposito(bigint,boolean,numeric), resolver_pedido(bigint,boolean) from public, anon;
grant execute on function pedir_deposito(text,numeric,text), comprar(int,text), resolver_deposito(bigint,boolean,numeric), resolver_pedido(bigint,boolean) to authenticated;

-- tus paquetes y precios (editalos acá o en Table Editor > paquetes)
insert into paquetes (diamantes, precio, etiqueta) values
  (110, 1000, null), (341, 3000, null), (572, 5000, 'Más pedido'),
  (1166, 10000, null), (2398, 20000, null), (6160, 50000, null);

-- DESPUÉS de crear tu cuenta en la página, hacete admin (cambiá el email):
-- update perfiles set es_admin = true where email = 'TU_EMAIL@ejemplo.com';

-- ===== 2) MIGRACIÓN CENTRAL ONE =====
alter table paquetes add column if not exists co_product_id uuid;
alter table pedidos add column if not exists co_order_id uuid, add column if not exists co_reference text, add column if not exists motivo text;

-- Solo la Edge Function (service_role) puede cerrar pedidos automáticamente
create or replace function cerrar_pedido_auto(p_id bigint, p_ok boolean, p_motivo text) returns void language plpgsql security definer set search_path = public as $f$
declare v_ped pedidos%rowtype;
begin
  select * into v_ped from pedidos where id = p_id and estado = 'pendiente' for update;
  if not found then return; end if;
  if p_ok then
    update pedidos set estado = 'entregado', motivo = p_motivo where id = p_id;
  else
    update perfiles set saldo = saldo + v_ped.precio where id = v_ped.usuario;
    update pedidos set estado = 'rechazado', motivo = p_motivo where id = p_id;
  end if;
end $f$;
revoke execute on function cerrar_pedido_auto(bigint,boolean,text) from public, anon, authenticated;
grant execute on function cerrar_pedido_auto(bigint,boolean,text) to service_role;

-- Después de ver el catálogo en el panel admin, asigná el product_id a cada paquete:
-- update paquetes set co_product_id = 'UUID-DEL-CATALOGO' where diamantes = 110;

-- ===== 3) PRECIOS DESDE EL PANEL ADMIN =====
-- Permite que solo un admin cambie el precio de un paquete.
create or replace function actualizar_precio(p_diamantes int, p_precio numeric) returns void language plpgsql security definer set search_path = public as $f$
begin
  if not soy_admin() then raise exception 'permiso'; end if;
  if p_precio is null or p_precio <= 0 then raise exception 'precio'; end if;
  update paquetes set precio = p_precio where diamantes = p_diamantes;
end $f$;
revoke execute on function actualizar_precio(int,numeric) from public, anon;
grant execute on function actualizar_precio(int,numeric) to authenticated;
