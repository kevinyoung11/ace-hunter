\set ON_ERROR_STOP on
do $$
begin
  if not exists (select 1 from pg_roles where rolname='ace_hunter_ops') then create role ace_hunter_ops; end if;
  if not exists (select 1 from pg_roles where rolname='ace_hunter_github_runtime') then create role ace_hunter_github_runtime; end if;
  if not exists (select 1 from pg_roles where rolname='ace_hunter_mac_worker') then create role ace_hunter_mac_worker; end if;
end $$;
alter role ace_hunter_ops nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
alter role ace_hunter_github_runtime nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
alter role ace_hunter_mac_worker nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
