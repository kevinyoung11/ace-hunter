\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ace_hunter_owner') then
    create role ace_hunter_owner;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ace_hunter_migrator') then
    create role ace_hunter_migrator;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ace_hunter_runtime') then
    create role ace_hunter_runtime;
  end if;
end
$$;

alter role ace_hunter_owner nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
alter role ace_hunter_migrator login password 'test-migrator' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
alter role ace_hunter_runtime login password 'test-runtime' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;

do $$
declare
  membership record;
begin
  for membership in
    select granted.rolname granted_role, member.rolname member_role
      from pg_auth_members edge
      join pg_roles granted on granted.oid=edge.roleid
      join pg_roles member on member.oid=edge.member
     where (granted.rolname like 'ace_hunter_%' or member.rolname like 'ace_hunter_%')
       and not (granted.rolname='ace_hunter_owner' and member.rolname='ace_hunter_migrator')
  loop
    execute format('revoke %I from %I',membership.granted_role,membership.member_role);
  end loop;
  if not pg_has_role('ace_hunter_migrator','ace_hunter_owner','member') then
    grant ace_hunter_owner to ace_hunter_migrator;
  end if;
end
$$;

create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create table if not exists auth.users (id uuid primary key);
revoke all on schema auth from public, ace_hunter_migrator, ace_hunter_runtime;
revoke all on auth.users from public, ace_hunter_owner, ace_hunter_migrator, ace_hunter_runtime;
grant usage on schema auth to ace_hunter_owner;
grant references (id) on auth.users to ace_hunter_owner;

do $$
begin
  perform gen_random_uuid();
exception when undefined_function then
  raise exception 'gen_random_uuid() must be available to migrations';
end
$$;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'ace_hunter') then
    execute 'create schema ace_hunter authorization ace_hunter_owner';
  end if;
end
$$;
alter schema ace_hunter owner to ace_hunter_owner;
revoke all on schema ace_hunter from public, ace_hunter_runtime;

do $$
begin
  if has_table_privilege('ace_hunter_owner', 'auth.users', 'select') then
    raise exception 'ace_hunter_owner must not have SELECT on auth.users';
  end if;
end
$$;
