-- =====================================================================
-- M-A Building Field Timesheets — database setup
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run once on a new project.
-- =====================================================================

-- ---------- Tables ----------------------------------------------------

-- One row per person who can log in. Created automatically when you add
-- a user under Authentication > Users.
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null default '',
  email       text,
  role        text not null default 'employee'
              check (role in ('employee', 'foreman', 'supervisor')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.jobsites (
  id          uuid primary key default gen_random_uuid(),
  job_number  text not null default '',
  name        text not null,
  address     text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Which foremen run which jobsites. A foreman can enter hours for any
-- employee on a jobsite they are assigned to.
create table public.jobsite_foremen (
  jobsite_id  uuid not null references public.jobsites (id) on delete cascade,
  foreman_id  uuid not null references public.profiles (id) on delete cascade,
  primary key (jobsite_id, foreman_id)
);

-- One row per employee, per jobsite, per cost code, per day.
create table public.time_entries (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.profiles (id) on delete restrict,
  jobsite_id   uuid not null references public.jobsites (id) on delete restrict,
  work_date    date not null,
  cost_code    text not null default '',
  hours        numeric(4,2) not null check (hours > 0 and hours <= 24),
  notes        text not null default '',
  status       text not null default 'submitted'
               check (status in ('submitted', 'approved', 'rejected')),
  entered_by   uuid references public.profiles (id),
  approved_by  uuid references public.profiles (id),
  approved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (employee_id, jobsite_id, work_date, cost_code)
);

create index time_entries_date_idx    on public.time_entries (work_date);
create index time_entries_jobsite_idx on public.time_entries (jobsite_id, work_date);

-- ---------- Helper functions (used by the security rules) -------------

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.is_supervisor()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'supervisor', false)
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select public.my_role() is not null
$$;

create or replace function public.is_foreman_for(site uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.my_role() in ('foreman', 'supervisor')
     and exists (select 1 from public.jobsite_foremen
                 where jobsite_id = site and foreman_id = auth.uid())
$$;

-- ---------- Triggers ---------------------------------------------------

-- Create a profile automatically for every new login account.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Stamp who entered/changed each entry and keep approval fields honest.
create or replace function public.time_entry_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then
    if tg_op = 'INSERT' or new.hours is distinct from old.hours
       or new.notes is distinct from old.notes
       or new.cost_code is distinct from old.cost_code then
      new.entered_by := auth.uid();
    end if;
  end if;
  if new.status = 'approved' then
    if tg_op = 'INSERT' or old.status is distinct from 'approved' then
      new.approved_by := auth.uid();
      new.approved_at := now();
    end if;
  else
    new.approved_by := null;
    new.approved_at := null;
  end if;
  return new;
end $$;

create trigger time_entries_stamp
  before insert or update on public.time_entries
  for each row execute function public.time_entry_stamp();

-- ---------- Row-level security ----------------------------------------

alter table public.profiles        enable row level security;
alter table public.jobsites        enable row level security;
alter table public.jobsite_foremen enable row level security;
alter table public.time_entries    enable row level security;

-- Profiles: everyone signed in can see the crew list (names/roles);
-- only supervisors can change names, roles, or deactivate people.
create policy profiles_read   on public.profiles for select to authenticated
  using (public.is_active_user());
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_supervisor()) with check (public.is_supervisor());

-- Jobsites & foreman assignments: readable by all, managed by supervisors.
create policy jobsites_read  on public.jobsites for select to authenticated
  using (public.is_active_user());
create policy jobsites_write on public.jobsites for all to authenticated
  using (public.is_supervisor()) with check (public.is_supervisor());

create policy jf_read  on public.jobsite_foremen for select to authenticated
  using (public.is_active_user());
create policy jf_write on public.jobsite_foremen for all to authenticated
  using (public.is_supervisor()) with check (public.is_supervisor());

-- Time entries
--   Employees: see/edit their own, until approved.
--   Foremen:   see/edit anyone's on jobsites they run, until approved.
--   Supervisors: see/edit everything and approve/reject.
create policy te_read on public.time_entries for select to authenticated
  using (public.is_active_user() and (
         employee_id = auth.uid()
      or public.is_foreman_for(jobsite_id)
      or public.is_supervisor()));

create policy te_insert on public.time_entries for insert to authenticated
  with check (public.is_supervisor() or (
         public.is_active_user()
     and status = 'submitted'
     and (employee_id = auth.uid() or public.is_foreman_for(jobsite_id))));

create policy te_update on public.time_entries for update to authenticated
  using (public.is_supervisor() or (
         public.is_active_user()
     and status <> 'approved'
     and (employee_id = auth.uid() or public.is_foreman_for(jobsite_id))))
  with check (public.is_supervisor() or (
         status = 'submitted'
     and (employee_id = auth.uid() or public.is_foreman_for(jobsite_id))));

create policy te_delete on public.time_entries for delete to authenticated
  using (public.is_supervisor() or (
         public.is_active_user()
     and status <> 'approved'
     and (employee_id = auth.uid() or public.is_foreman_for(jobsite_id))));

-- =====================================================================
-- AFTER RUNNING THIS: make yourself a supervisor. Replace the email:
--
--   update public.profiles set role = 'supervisor', full_name = 'Joe Thomas'
--   where email = 'jthomas@mabldg.com';
-- =====================================================================
