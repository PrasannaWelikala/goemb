-- =====================================================================
-- GoEmb database schema
-- Supabase (Postgres + PostGIS). Run in the SQL editor, top to bottom.
--
-- After running:
--   1. In Supabase: Authentication > Users > Add user (your email and a strong
--      password, tick Auto Confirm). Then make that account the admin:
--        update profiles set role = 'admin'
--         where id = (select id from auth.users where email = 'rngprsnn@gmail.com');
--   2. Set real fares:  update fare_settings set base_fare = ..., per_km = ...,
--        active = true where vehicle = 'tuk';   (all start inactive with 0 values)
--   3. Set commission:  update billing_settings set commission_percent = ...,
--        subscription_fee = ..., credit_limit = ...;
--   4. Enable the pg_cron extension (Database > Extensions), then run the
--      two cron.schedule lines near the end of this file.
--
-- Not yet run against a real database. Run it on a fresh Supabase project
-- first and fix any errors before using it for anything real.
-- =====================================================================

create extension if not exists postgis with schema extensions;
set search_path = public, extensions;

-- ---------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------
create type user_role         as enum ('customer', 'driver', 'admin', 'staff');
create type vehicle_type      as enum ('tuk', 'bike', 'car', 'van', 'small_lorry');
create type driver_status     as enum ('pending', 'approved', 'rejected', 'suspended');
create type commission_plan   as enum ('percentage', 'subscription');
create type trip_status       as enum ('requested', 'accepted', 'arrived', 'in_progress',
                                       'completed', 'cancelled_by_customer',
                                       'cancelled_by_driver', 'no_drivers');
create type offer_status      as enum ('offered', 'accepted', 'declined', 'expired');
create type plan_change_status as enum ('pending', 'applied', 'cancelled');
create type statement_status  as enum ('issued', 'paid');
create type payment_method    as enum ('bank_transfer', 'cash', 'other');

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  role       user_role not null default 'customer',
  full_name  text,
  phone      text unique,
  created_at timestamptz not null default now()
);

create table drivers (
  id           uuid primary key references profiles (id) on delete cascade,
  status       driver_status not null default 'pending',
  nic          text,
  licence_no   text,
  is_online    boolean not null default false,
  plan         commission_plan not null default 'percentage',
  rating_avg   numeric(3,2) not null default 0,
  rating_count int not null default 0,
  created_at   timestamptz not null default now()
);

create table driver_locations (
  driver_id  uuid primary key references drivers (id) on delete cascade,
  location   geography(point, 4326) not null,
  updated_at timestamptz not null default now()
);
create index driver_locations_gix on driver_locations using gist (location);

create table vehicles (
  id         uuid primary key default gen_random_uuid(),
  driver_id  uuid not null references drivers (id) on delete cascade,
  type       vehicle_type not null,
  plate      text not null unique,
  make_model text,
  color      text,
  seats      int,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index vehicles_driver_idx on vehicles (driver_id);

create table driver_documents (
  id           uuid primary key default gen_random_uuid(),
  driver_id    uuid not null references drivers (id) on delete cascade,
  doc_type     text not null,           -- licence, vehicle_registration, insurance, photo
  storage_path text not null,           -- path in the 'driver-docs' bucket
  verified     boolean not null default false,
  uploaded_at  timestamptz not null default now()
);

-- One row per vehicle type. All start inactive with zero values on purpose:
-- set the real rates and activate them yourself.
create table fare_settings (
  vehicle        vehicle_type primary key,
  base_fare      numeric(10,2) not null default 0,
  per_km         numeric(10,2) not null default 0,
  per_min        numeric(10,2) not null default 0,
  min_fare       numeric(10,2) not null default 0,
  loading_charge numeric(10,2) not null default 0,   -- small_lorry only
  active         boolean not null default false
);
insert into fare_settings (vehicle)
  select unnest(enum_range(null::vehicle_type));

-- Single row of global settings.
create table billing_settings (
  id                 boolean primary key default true check (id),
  commission_percent numeric(5,2)  check (commission_percent between 0 and 100),
  subscription_fee   numeric(10,2) check (subscription_fee >= 0),
  credit_limit       numeric(12,2),            -- null = no limit
  payment_days       int not null default 7,   -- days to pay after a statement is issued
  grace_days         int not null default 3,   -- extra days before a driver is blocked
  search_radius_m    int not null default 3000,
  offer_timeout_s    int not null default 60,
  max_offers         int not null default 10
);
insert into billing_settings (id) values (true);

create table trips (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references profiles (id),
  driver_id          uuid references drivers (id),
  vehicle            vehicle_type not null,
  status             trip_status not null default 'requested',
  pickup             geography(point, 4326) not null,
  pickup_address     text,
  dropoff            geography(point, 4326) not null,
  dropoff_address    text,
  loading_requested  boolean not null default false,
  est_distance_km    numeric(8,2),
  est_duration_min   numeric(8,2),
  est_fare           numeric(10,2),
  distance_km        numeric(8,2),
  duration_min       numeric(8,2),
  fare               numeric(10,2),              -- distance/time fare
  loading_charge     numeric(10,2) not null default 0,
  total_fare         numeric(10,2),              -- cash the customer pays
  commission_plan    commission_plan,            -- plan active on the day of the trip
  commission_amount  numeric(10,2) not null default 0,
  driver_rating      smallint check (driver_rating between 1 and 5),
  rating_comment     text,
  requested_at       timestamptz not null default now(),
  accepted_at        timestamptz,
  arrived_at         timestamptz,
  started_at         timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz
);
create index trips_customer_idx on trips (customer_id, requested_at desc);
create index trips_driver_idx   on trips (driver_id, status);
create index trips_status_idx   on trips (status, requested_at);

create table trip_offers (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references trips (id) on delete cascade,
  driver_id  uuid not null references drivers (id) on delete cascade,
  status     offer_status not null default 'offered',
  offered_at timestamptz not null default now(),
  unique (trip_id, driver_id)
);
create index trip_offers_driver_idx on trip_offers (driver_id, status);

create table driver_plan_changes (
  id             uuid primary key default gen_random_uuid(),
  driver_id      uuid not null references drivers (id) on delete cascade,
  requested_plan commission_plan not null,
  requested_at   timestamptz not null default now(),
  effective_from date not null,                 -- 1st of the next month
  status         plan_change_status not null default 'pending'
);
create unique index one_pending_plan_change on driver_plan_changes (driver_id)
  where status = 'pending';

create table monthly_statements (
  id               uuid primary key default gen_random_uuid(),
  driver_id        uuid not null references drivers (id),
  period_start     date not null,
  period_end       date not null,               -- exclusive
  plan             commission_plan not null,
  trips_count      int not null default 0,
  cash_collected   numeric(12,2) not null default 0,
  commission_due   numeric(12,2) not null default 0,
  subscription_fee numeric(12,2) not null default 0,
  total_due        numeric(12,2) not null,
  status           statement_status not null default 'issued',
  issued_at        timestamptz not null default now(),
  due_date         date not null,
  paid_at          timestamptz,
  unique (driver_id, period_start)
);
create index statements_driver_idx on monthly_statements (driver_id, period_start desc);

create table commission_ledger (
  id           uuid primary key default gen_random_uuid(),
  driver_id    uuid not null references drivers (id),
  trip_id      uuid not null unique references trips (id),
  amount       numeric(10,2) not null,
  period_month date not null,                   -- 1st of the month (Asia/Colombo)
  statement_id uuid references monthly_statements (id),
  created_at   timestamptz not null default now()
);
create index ledger_driver_idx on commission_ledger (driver_id, statement_id);

create table payments (
  id           uuid primary key default gen_random_uuid(),
  statement_id uuid not null references monthly_statements (id),
  driver_id    uuid not null references drivers (id),
  amount       numeric(12,2) not null check (amount > 0),
  method       payment_method not null,
  reference    text,
  note         text,
  recorded_by  uuid references profiles (id),
  recorded_at  timestamptz not null default now()
);
create index payments_statement_idx on payments (statement_id);

-- ---------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------
create or replace function colombo_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Colombo')::date $$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('admin', 'staff'))
$$;

-- Unbilled commission + unpaid balance on issued statements.
create or replace function driver_outstanding(p_driver uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(amount) from commission_ledger
                    where driver_id = p_driver and statement_id is null), 0)
       + coalesce((select sum(s.total_due - coalesce((select sum(p.amount) from payments p
                                                       where p.statement_id = s.id), 0))
                     from monthly_statements s
                    where s.driver_id = p_driver and s.status = 'issued'), 0)
$$;

-- True if the driver must settle before going online or accepting trips.
create or replace function driver_blocked(p_driver uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(driver_outstanding(p_driver) > (select credit_limit from billing_settings), false)
      or exists (select 1
                   from monthly_statements s, billing_settings b
                  where s.driver_id = p_driver
                    and s.status = 'issued'
                    and s.due_date + b.grace_days < colombo_today())
$$;

-- Fare from distance and time only (loading charge is added separately).
create or replace function calc_fare(p_vehicle vehicle_type, p_km numeric, p_min numeric)
returns numeric language plpgsql stable as $$
declare f fare_settings;
begin
  select * into f from fare_settings where vehicle = p_vehicle;
  if not found then raise exception 'No fare settings for %', p_vehicle; end if;
  return round(greatest(f.min_fare,
                        f.base_fare + f.per_km * coalesce(p_km, 0) + f.per_min * coalesce(p_min, 0)), 2);
end $$;

-- ---------------------------------------------------------------------
-- Profiles: auto-create on sign up, and nobody can promote themselves
-- ---------------------------------------------------------------------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, phone, full_name)
  values (new.id, new.phone, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

create or replace function protect_profile_role() returns trigger
language plpgsql as $$
begin
  if new.role is distinct from old.role
     and current_user not in ('postgres', 'supabase_admin', 'service_role')
     and not is_admin() then
    raise exception 'Only an administrator can change a role';
  end if;
  return new;
end $$;

create trigger profiles_protect_role
  before update on profiles
  for each row execute function protect_profile_role();

-- ---------------------------------------------------------------------
-- Driver functions
-- ---------------------------------------------------------------------
create or replace function register_driver(
  p_full_name text, p_nic text, p_licence_no text, p_plan commission_plan,
  p_vehicle vehicle_type, p_plate text, p_make_model text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if exists (select 1 from profiles where id = v_uid and role in ('admin', 'staff')) then
    raise exception 'Admin accounts cannot register as drivers';
  end if;
  if exists (select 1 from drivers where id = v_uid and status <> 'pending') then
    raise exception 'Registration is already processed';
  end if;

  update profiles set role = 'driver', full_name = p_full_name where id = v_uid;

  insert into drivers (id, nic, licence_no, plan)
  values (v_uid, p_nic, p_licence_no, p_plan)
  on conflict (id) do update set nic = excluded.nic, licence_no = excluded.licence_no;

  insert into vehicles (driver_id, type, plate, make_model)
  values (v_uid, p_vehicle, upper(p_plate), p_make_model)
  on conflict (plate) do update
    set type = excluded.type, make_model = excluded.make_model
    where vehicles.driver_id = v_uid;
end $$;

create or replace function set_online(p_online boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_online then
    if not exists (select 1 from drivers where id = auth.uid() and status = 'approved') then
      raise exception 'Your account is not approved yet';
    end if;
    if driver_blocked(auth.uid()) then
      raise exception 'Please settle your outstanding commission to go online';
    end if;
  end if;
  update drivers set is_online = p_online where id = auth.uid();
end $$;

create or replace function update_location(p_lat double precision, p_lng double precision)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into driver_locations (driver_id, location, updated_at)
  values (auth.uid(), st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography, now())
  on conflict (driver_id) do update
    set location = excluded.location, updated_at = now();
end $$;

create or replace function my_balance()
returns table (outstanding numeric, blocked boolean)
language sql stable security definer set search_path = public as $$
  select driver_outstanding(auth.uid()), driver_blocked(auth.uid())
$$;

-- Plan change: latest request wins, effective the 1st of next month.
-- Asking for the current plan cancels any pending request.
create or replace function request_plan_change(p_plan commission_plan)
returns driver_plan_changes
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_cur commission_plan; v_row driver_plan_changes;
begin
  select plan into v_cur from drivers where id = v_uid;
  if not found then raise exception 'Not a driver'; end if;
  update driver_plan_changes set status = 'cancelled'
   where driver_id = v_uid and status = 'pending';
  if p_plan = v_cur then return null; end if;
  insert into driver_plan_changes (driver_id, requested_plan, effective_from)
  values (v_uid, p_plan, (date_trunc('month', colombo_today()::timestamp) + interval '1 month')::date)
  returning * into v_row;
  return v_row;
end $$;

-- ---------------------------------------------------------------------
-- Trip functions
-- ---------------------------------------------------------------------
create or replace function request_trip(
  p_vehicle vehicle_type,
  p_pickup_lat double precision, p_pickup_lng double precision, p_pickup_address text,
  p_drop_lat double precision, p_drop_lng double precision, p_drop_address text,
  p_est_distance_km numeric, p_est_duration_min numeric,
  p_loading boolean default false)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_trip uuid;
  v_f fare_settings;
  v_b billing_settings;
  v_pickup geography;
  v_dropoff geography;
  v_est numeric;
  v_count int;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if exists (select 1 from trips where customer_id = v_uid
              and status in ('requested', 'accepted', 'arrived', 'in_progress')) then
    raise exception 'You already have an active trip';
  end if;

  select * into v_f from fare_settings where vehicle = p_vehicle and active;
  if not found then raise exception 'This vehicle type is not available'; end if;
  select * into v_b from billing_settings;

  v_pickup  := st_setsrid(st_makepoint(p_pickup_lng, p_pickup_lat), 4326)::geography;
  v_dropoff := st_setsrid(st_makepoint(p_drop_lng, p_drop_lat), 4326)::geography;

  v_est := calc_fare(p_vehicle, p_est_distance_km, p_est_duration_min);
  if p_loading and p_vehicle = 'small_lorry' then v_est := v_est + v_f.loading_charge; end if;

  insert into trips (customer_id, vehicle, pickup, pickup_address, dropoff, dropoff_address,
                     loading_requested, est_distance_km, est_duration_min, est_fare)
  values (v_uid, p_vehicle, v_pickup, p_pickup_address, v_dropoff, p_drop_address,
          coalesce(p_loading, false) and p_vehicle = 'small_lorry',
          p_est_distance_km, p_est_duration_min, v_est)
  returning id into v_trip;

  -- Offer the trip to the nearest eligible online drivers.
  insert into trip_offers (trip_id, driver_id)
  select v_trip, d.id
    from drivers d
    join driver_locations l on l.driver_id = d.id
   where d.status = 'approved'
     and d.is_online
     and l.updated_at > now() - interval '2 minutes'
     and st_dwithin(l.location, v_pickup, v_b.search_radius_m)
     and exists (select 1 from vehicles v
                  where v.driver_id = d.id and v.active and v.type = p_vehicle)
     and not driver_blocked(d.id)
     and not exists (select 1 from trips t
                      where t.driver_id = d.id
                        and t.status in ('accepted', 'arrived', 'in_progress'))
   order by st_distance(l.location, v_pickup)
   limit v_b.max_offers;
  get diagnostics v_count = row_count;

  if v_count = 0 then
    update trips set status = 'no_drivers' where id = v_trip;
  end if;
  return v_trip;
end $$;

-- First driver to call this wins; the update only succeeds while status is 'requested'.
create or replace function accept_trip(p_trip uuid) returns trips
language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := auth.uid(); v_row trips;
begin
  if not exists (select 1 from drivers where id = v_uid and status = 'approved' and is_online) then
    raise exception 'You must be online and approved to accept trips';
  end if;
  if driver_blocked(v_uid) then
    raise exception 'Please settle your outstanding commission';
  end if;

  update trips set status = 'accepted', driver_id = v_uid, accepted_at = now()
   where id = p_trip and status = 'requested'
     and exists (select 1 from trip_offers o
                  where o.trip_id = p_trip and o.driver_id = v_uid and o.status = 'offered')
  returning * into v_row;
  if not found then raise exception 'This trip is no longer available'; end if;

  update trip_offers
     set status = (case when driver_id = v_uid then 'accepted' else 'expired' end)::offer_status
   where trip_id = p_trip and status = 'offered';
  return v_row;
end $$;

-- accepted -> arrived, arrived -> in_progress
create or replace function advance_trip(p_trip uuid, p_to trip_status) returns trips
language plpgsql security definer set search_path = public, extensions as $$
declare v_row trips;
begin
  if p_to = 'arrived' then
    update trips set status = 'arrived', arrived_at = now()
     where id = p_trip and driver_id = auth.uid() and status = 'accepted'
    returning * into v_row;
  elsif p_to = 'in_progress' then
    update trips set status = 'in_progress', started_at = now()
     where id = p_trip and driver_id = auth.uid() and status = 'arrived'
    returning * into v_row;
  else
    raise exception 'Invalid status change';
  end if;
  if not found then raise exception 'Trip not found or in the wrong state'; end if;
  return v_row;
end $$;

-- NOTE: distance and duration come from the driver app in this MVP.
-- Later, compute them on the server from the recorded GPS trail.
create or replace function complete_trip(p_trip uuid, p_distance_km numeric, p_duration_min numeric)
returns trips language plpgsql security definer set search_path = public, extensions as $$
declare
  t trips; d drivers; f fare_settings; b billing_settings;
  v_fare numeric; v_load numeric := 0; v_total numeric; v_comm numeric := 0;
begin
  select * into t from trips
   where id = p_trip and driver_id = auth.uid() and status = 'in_progress' for update;
  if not found then raise exception 'Trip not found or not in progress'; end if;

  select * into d from drivers where id = t.driver_id;
  select * into f from fare_settings where vehicle = t.vehicle;
  select * into b from billing_settings;

  v_fare := calc_fare(t.vehicle, p_distance_km, p_duration_min);
  if t.loading_requested and t.vehicle = 'small_lorry' then v_load := f.loading_charge; end if;
  v_total := v_fare + v_load;

  if d.plan = 'percentage' then
    if b.commission_percent is null then
      raise exception 'Commission percent is not configured';
    end if;
    v_comm := round(v_total * b.commission_percent / 100, 2);
  end if;

  update trips
     set status = 'completed', completed_at = now(),
         distance_km = p_distance_km, duration_min = p_duration_min,
         fare = v_fare, loading_charge = v_load, total_fare = v_total,
         commission_plan = d.plan, commission_amount = v_comm
   where id = t.id
  returning * into t;

  if v_comm > 0 then
    insert into commission_ledger (driver_id, trip_id, amount, period_month)
    values (t.driver_id, t.id, v_comm,
            date_trunc('month', now() at time zone 'Asia/Colombo')::date);
  end if;
  return t;
end $$;

create or replace function cancel_trip(p_trip uuid) returns trips
language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := auth.uid(); v_row trips;
begin
  update trips
     set status = (case when customer_id = v_uid then 'cancelled_by_customer'
                        else 'cancelled_by_driver' end)::trip_status,
         cancelled_at = now()
   where id = p_trip
     and ((customer_id = v_uid and status in ('requested', 'accepted', 'arrived'))
       or (driver_id = v_uid and status in ('accepted', 'arrived')))
  returning * into v_row;
  if not found then raise exception 'This trip cannot be cancelled'; end if;
  update trip_offers set status = 'expired' where trip_id = p_trip and status = 'offered';
  return v_row;
end $$;

create or replace function rate_trip(p_trip uuid, p_rating int, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_driver uuid;
begin
  if p_rating not between 1 and 5 then raise exception 'Rating must be 1 to 5'; end if;
  update trips set driver_rating = p_rating, rating_comment = p_comment
   where id = p_trip and customer_id = auth.uid()
     and status = 'completed' and driver_rating is null
  returning driver_id into v_driver;
  if not found then raise exception 'This trip cannot be rated'; end if;
  update drivers
     set rating_avg = round((rating_avg * rating_count + p_rating) / (rating_count + 1), 2),
         rating_count = rating_count + 1
   where id = v_driver;
end $$;

-- Customer sees only the assigned driver's public details.
create or replace function get_trip_driver(p_trip uuid)
returns table (driver_id uuid, driver_name text, driver_phone text,
               rating_avg numeric, plate text, make_model text, vehicle_type vehicle_type)
language sql stable security definer set search_path = public as $$
  select d.id, p.full_name, p.phone, d.rating_avg, v.plate, v.make_model, v.type
    from trips t
    join drivers d  on d.id = t.driver_id
    join profiles p on p.id = d.id
    left join lateral (select * from vehicles
                        where driver_id = d.id and type = t.vehicle and active
                        limit 1) v on true
   where t.id = p_trip and t.customer_id = auth.uid()
$$;

-- Driver sees the customer's name and phone only for a trip they accepted.
create or replace function get_trip_customer(p_trip uuid)
returns table (customer_name text, customer_phone text)
language sql stable security definer set search_path = public as $$
  select p.full_name, p.phone
    from trips t join profiles p on p.id = t.customer_id
   where t.id = p_trip and t.driver_id = auth.uid()
$$;

-- Driver app: open trip requests for me (coordinates as plain numbers).
create or replace function my_open_offers()
returns table (trip_id uuid, vehicle vehicle_type,
               pickup_address text, pickup_lat double precision, pickup_lng double precision,
               dropoff_address text, dropoff_lat double precision, dropoff_lng double precision,
               est_distance_km numeric, est_fare numeric, loading_requested boolean,
               offered_at timestamptz)
language sql stable security definer set search_path = public, extensions as $$
  select t.id, t.vehicle,
         t.pickup_address,  st_y(t.pickup::geometry),  st_x(t.pickup::geometry),
         t.dropoff_address, st_y(t.dropoff::geometry), st_x(t.dropoff::geometry),
         t.est_distance_km, t.est_fare, t.loading_requested, o.offered_at
    from trip_offers o
    join trips t on t.id = o.trip_id
   where o.driver_id = auth.uid()
     and o.status = 'offered'
     and t.status = 'requested'
     and o.offered_at > now() - make_interval(secs => (select offer_timeout_s from billing_settings))
   order by o.offered_at
$$;

-- Driver app: the trip I am currently on, with the customer's name and phone.
create or replace function my_active_trip()
returns table (trip_id uuid, status trip_status, vehicle vehicle_type,
               pickup_address text, pickup_lat double precision, pickup_lng double precision,
               dropoff_address text, dropoff_lat double precision, dropoff_lng double precision,
               est_distance_km numeric, est_fare numeric, loading_requested boolean,
               started_at timestamptz, customer_name text, customer_phone text)
language sql stable security definer set search_path = public, extensions as $$
  select t.id, t.status, t.vehicle,
         t.pickup_address,  st_y(t.pickup::geometry),  st_x(t.pickup::geometry),
         t.dropoff_address, st_y(t.dropoff::geometry), st_x(t.dropoff::geometry),
         t.est_distance_km, t.est_fare, t.loading_requested,
         t.started_at, p.full_name, p.phone
    from trips t
    join profiles p on p.id = t.customer_id
   where t.driver_id = auth.uid()
     and t.status in ('accepted', 'arrived', 'in_progress')
   order by t.accepted_at desc
   limit 1
$$;

create or replace function decline_offer(p_trip uuid) returns void
language sql security definer set search_path = public as $$
  update trip_offers set status = 'declined'
   where trip_id = p_trip and driver_id = auth.uid() and status = 'offered'
$$;

-- Marks requests nobody accepted in time. Run every minute by cron.
create or replace function expire_stale_trips() returns void
language plpgsql security definer set search_path = public as $$
begin
  with x as (
    update trips set status = 'no_drivers'
     where status = 'requested'
       and requested_at < now() - make_interval(secs => (select offer_timeout_s from billing_settings))
    returning id)
  update trip_offers set status = 'expired'
   where status = 'offered' and trip_id in (select id from x);
end $$;

-- ---------------------------------------------------------------------
-- Month-end billing
-- ---------------------------------------------------------------------
-- Builds statements for one month (p_period_start = 1st of that month).
-- Safe to run twice: existing statements are skipped.
create or replace function generate_monthly_statements(p_period_start date) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_b billing_settings;
  v_end date := (p_period_start + interval '1 month')::date;
  v_from timestamptz := p_period_start::timestamp at time zone 'Asia/Colombo';
  v_to   timestamptz := (p_period_start + interval '1 month')::timestamp at time zone 'Asia/Colombo';
  r record;
  v_trips int; v_cash numeric; v_comm numeric; v_fee numeric; v_total numeric;
  v_stmt uuid; v_n int := 0;
begin
  select * into v_b from billing_settings;

  for r in select id, plan from drivers where status in ('approved', 'suspended') loop
    if exists (select 1 from monthly_statements
                where driver_id = r.id and period_start = p_period_start) then
      continue;
    end if;

    select count(*), coalesce(sum(total_fare), 0) into v_trips, v_cash
      from trips
     where driver_id = r.id and status = 'completed'
       and completed_at >= v_from and completed_at < v_to;

    select coalesce(sum(amount), 0) into v_comm
      from commission_ledger
     where driver_id = r.id and statement_id is null and period_month = p_period_start;

    v_fee := 0;
    if r.plan = 'subscription' then
      if v_b.subscription_fee is null then
        raise exception 'Subscription fee is not configured';
      end if;
      v_fee := v_b.subscription_fee;
    end if;

    v_total := v_comm + v_fee;
    if v_total <= 0 then continue; end if;

    insert into monthly_statements
      (driver_id, period_start, period_end, plan, trips_count, cash_collected,
       commission_due, subscription_fee, total_due, due_date)
    values
      (r.id, p_period_start, v_end, r.plan, v_trips, v_cash,
       v_comm, v_fee, v_total, colombo_today() + v_b.payment_days)
    returning id into v_stmt;

    update commission_ledger set statement_id = v_stmt
     where driver_id = r.id and statement_id is null and period_month = p_period_start;

    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function apply_plan_changes() returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update drivers d set plan = c.requested_plan
    from driver_plan_changes c
   where c.driver_id = d.id and c.status = 'pending' and c.effective_from <= colombo_today();
  get diagnostics v_n = row_count;
  update driver_plan_changes set status = 'applied'
   where status = 'pending' and effective_from <= colombo_today();
  return v_n;
end $$;

-- Run daily by cron. Only acts on the 1st to 5th (Colombo time), so a failed
-- run (for example a missing setting) is retried the next day.
-- Order matters: statements first (using last month's plan), then plan changes.
create or replace function run_month_start() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_today date := colombo_today();
begin
  if extract(day from v_today) > 5 then return; end if;
  perform generate_monthly_statements(
    (date_trunc('month', v_today::timestamp) - interval '1 month')::date);
  perform apply_plan_changes();
end $$;

create or replace function record_payment(
  p_statement uuid, p_amount numeric, p_method payment_method,
  p_reference text default null, p_note text default null)
returns monthly_statements language plpgsql security definer set search_path = public as $$
declare s monthly_statements; v_paid numeric;
begin
  if not is_admin() then raise exception 'Only the administrator can record payments'; end if;
  select * into s from monthly_statements where id = p_statement for update;
  if not found then raise exception 'Statement not found'; end if;

  select coalesce(sum(amount), 0) into v_paid from payments where statement_id = s.id;
  if p_amount <= 0 or v_paid + p_amount > s.total_due then
    raise exception 'Amount must be above 0 and not more than the remaining balance';
  end if;

  insert into payments (statement_id, driver_id, amount, method, reference, note, recorded_by)
  values (s.id, s.driver_id, p_amount, p_method, p_reference, p_note, auth.uid());

  if v_paid + p_amount >= s.total_due then
    update monthly_statements set status = 'paid', paid_at = now() where id = s.id;
  end if;
  select * into s from monthly_statements where id = p_statement;
  return s;
end $$;

-- Admin overview: who owes what.
create or replace view driver_balances as
  select d.id as driver_id, p.full_name, p.phone, d.status, d.plan,
         driver_outstanding(d.id) as outstanding,
         driver_blocked(d.id)     as blocked
    from drivers d join profiles p on p.id = d.id
   where is_staff();

-- Live map data for the admin panel (coordinates as plain numbers).
create or replace view live_drivers as
  select d.id as driver_id, p.full_name, p.phone, l.updated_at,
         st_y(l.location::geometry) as lat, st_x(l.location::geometry) as lng,
         (select v.type  from vehicles v where v.driver_id = d.id and v.active limit 1) as vehicle_type,
         (select v.plate from vehicles v where v.driver_id = d.id and v.active limit 1) as plate
    from drivers d
    join profiles p on p.id = d.id
    join driver_locations l on l.driver_id = d.id
   where d.is_online and is_staff();

create or replace view live_trips as
  select t.id, t.status, t.vehicle, t.pickup_address,
         st_y(t.pickup::geometry) as lat, st_x(t.pickup::geometry) as lng
    from trips t
   where t.status in ('requested', 'accepted', 'arrived', 'in_progress') and is_staff();

-- Internal functions: callable by the database only, not by app users.
revoke execute on function driver_outstanding(uuid)            from public, anon, authenticated;
revoke execute on function driver_blocked(uuid)                from public, anon, authenticated;
revoke execute on function generate_monthly_statements(date)   from public, anon, authenticated;
revoke execute on function apply_plan_changes()                from public, anon, authenticated;
revoke execute on function run_month_start()                   from public, anon, authenticated;
revoke execute on function expire_stale_trips()                from public, anon, authenticated;
revoke all on driver_balances from anon;
revoke all on live_drivers    from anon;
revoke all on live_trips      from anon;

-- ---------------------------------------------------------------------
-- Row level security
-- Apps change data through the functions above (they bypass RLS safely).
-- Direct table writes are limited to the admin and a few own-row cases.
-- ---------------------------------------------------------------------
alter table profiles            enable row level security;
alter table drivers             enable row level security;
alter table driver_locations    enable row level security;
alter table vehicles            enable row level security;
alter table driver_documents    enable row level security;
alter table fare_settings       enable row level security;
alter table billing_settings    enable row level security;
alter table trips               enable row level security;
alter table trip_offers         enable row level security;
alter table driver_plan_changes enable row level security;
alter table monthly_statements  enable row level security;
alter table commission_ledger   enable row level security;
alter table payments            enable row level security;

-- profiles
create policy profiles_read_own   on profiles for select using (id = auth.uid() or is_staff());
create policy profiles_update_own on profiles for update using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin_all  on profiles for all using (is_admin()) with check (is_admin());

-- drivers (drivers cannot edit status, plan or online flag directly)
create policy drivers_read      on drivers for select using (id = auth.uid() or is_staff());
create policy drivers_admin_all on drivers for all using (is_admin()) with check (is_admin());

-- driver_locations (customers see only the driver on their active trip)
create policy locations_read on driver_locations for select using (
  driver_id = auth.uid() or is_staff()
  or exists (select 1 from trips t
              where t.customer_id = auth.uid() and t.driver_id = driver_locations.driver_id
                and t.status in ('accepted', 'arrived', 'in_progress')));

-- vehicles and documents
create policy vehicles_read      on vehicles for select using (driver_id = auth.uid() or is_staff());
create policy vehicles_own_write on vehicles for insert with check (driver_id = auth.uid());
create policy vehicles_own_edit  on vehicles for update using (driver_id = auth.uid()) with check (driver_id = auth.uid());
create policy vehicles_admin_all on vehicles for all using (is_admin()) with check (is_admin());

create policy docs_read      on driver_documents for select using (driver_id = auth.uid() or is_staff());
create policy docs_own_write on driver_documents for insert with check (driver_id = auth.uid());
create policy docs_admin_all on driver_documents for all using (is_admin()) with check (is_admin());

-- settings: everyone signed in can read (apps need fares and plan prices)
create policy fares_read      on fare_settings    for select to authenticated using (true);
create policy fares_admin     on fare_settings    for all using (is_admin()) with check (is_admin());
create policy billing_read    on billing_settings for select to authenticated using (true);
create policy billing_admin   on billing_settings for all using (is_admin()) with check (is_admin());

-- trips and offers (written only through functions)
create policy trips_read on trips for select using (
  customer_id = auth.uid() or driver_id = auth.uid() or is_staff()
  or exists (select 1 from trip_offers o where o.trip_id = trips.id and o.driver_id = auth.uid()));
create policy offers_read on trip_offers for select using (driver_id = auth.uid() or is_staff());

-- billing (read only; changes happen through functions)
create policy plan_changes_read on driver_plan_changes for select using (driver_id = auth.uid() or is_staff());
create policy statements_read   on monthly_statements for select using (driver_id = auth.uid() or is_staff());
create policy ledger_read       on commission_ledger   for select using (driver_id = auth.uid() or is_staff());
create policy payments_read     on payments            for select using (driver_id = auth.uid() or is_staff());

-- ---------------------------------------------------------------------
-- Realtime, storage
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table trips, trip_offers, driver_locations;

insert into storage.buckets (id, name, public)
values ('driver-docs', 'driver-docs', false)
on conflict (id) do nothing;

-- Drivers upload into a folder named after their user id.
create policy driver_docs_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'driver-docs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy driver_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'driver-docs'
         and ((storage.foldername(name))[1] = auth.uid()::text or is_staff()));

-- ---------------------------------------------------------------------
-- Scheduled jobs (enable the pg_cron extension first, then run these two)
-- pg_cron uses UTC. 18:35 UTC = 00:05 the next day in Sri Lanka.
-- ---------------------------------------------------------------------
-- select cron.schedule('goemb-month-start',  '35 18 * * *', $$select run_month_start()$$);
-- select cron.schedule('goemb-expire-trips', '* * * * *',   $$select expire_stale_trips()$$);
