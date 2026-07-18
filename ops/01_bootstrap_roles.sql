\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname='ace_hunter_owner') then
    create role ace_hunter_owner;
  end if;
  if not exists (select 1 from pg_roles where rolname='ace_hunter_migrator') then
    create role ace_hunter_migrator;
  end if;
  if not exists (select 1 from pg_roles where rolname='ace_hunter_runtime') then
    create role ace_hunter_runtime;
  end if;
end
$$;

do $ace_external_audit$
begin
  if exists (
    select 1 from pg_database o
      join pg_roles owner_role on owner_role.oid=o.datdba
     where owner_role.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_database o
      cross join lateral aclexplode(o.datacl) acl
      left join pg_roles grantee on grantee.oid=acl.grantee
      left join pg_roles grantor on grantor.oid=acl.grantor
     where grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_default_acl o
      join pg_roles owner_role on owner_role.oid=o.defaclrole
     where owner_role.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_default_acl o
      cross join lateral aclexplode(o.defaclacl) acl
      left join pg_roles grantee on grantee.oid=acl.grantee
      left join pg_roles grantor on grantor.oid=acl.grantor
     where grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_tablespace o
      join pg_roles owner_role on owner_role.oid=o.spcowner
     where owner_role.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_tablespace o
      cross join lateral aclexplode(o.spcacl) acl
      left join pg_roles grantee on grantee.oid=acl.grantee
      left join pg_roles grantor on grantor.oid=acl.grantor
     where grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_namespace o
      join pg_roles owner_role on owner_role.oid=o.nspowner
     where o.nspname<>'ace_hunter' and owner_role.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_namespace o
      cross join lateral aclexplode(o.nspacl) acl
      left join pg_roles grantee on grantee.oid=acl.grantee
      left join pg_roles grantor on grantor.oid=acl.grantor
     where o.nspname<>'ace_hunter'
       and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')
       and not (
         o.nspname='auth' and grantee.rolname='ace_hunter_owner'
         and acl.privilege_type='USAGE' and grantor.rolname not like 'ace_hunter_%'
       )
    union all
    select 1 from pg_class o join pg_namespace n on n.oid=o.relnamespace
      join pg_roles owner_role on owner_role.oid=o.relowner
     where n.nspname<>'ace_hunter' and o.relkind in ('r','p','v','m','f','S')
       and owner_role.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_class o join pg_namespace n on n.oid=o.relnamespace
      cross join lateral aclexplode(o.relacl) acl
      left join pg_roles grantee on grantee.oid=acl.grantee
      left join pg_roles grantor on grantor.oid=acl.grantor
     where n.nspname<>'ace_hunter' and o.relkind in ('r','p','v','m','f','S')
       and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')
    union all
    select 1 from pg_attribute a join pg_class o on o.oid=a.attrelid
      join pg_namespace n on n.oid=o.relnamespace
      cross join lateral aclexplode(a.attacl) acl
      left join pg_roles grantee on grantee.oid=acl.grantee
      left join pg_roles grantor on grantor.oid=acl.grantor
     where n.nspname<>'ace_hunter' and a.attnum>0 and not a.attisdropped
       and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')
       and not (
         n.nspname='auth' and o.relname='users' and a.attname='id'
         and grantee.rolname='ace_hunter_owner' and acl.privilege_type='REFERENCES'
         and grantor.rolname not like 'ace_hunter_%'
       )
    union all
    select 1 from pg_proc o join pg_namespace n on n.oid=o.pronamespace
      join pg_roles owner_role on owner_role.oid=o.proowner
     where n.nspname<>'ace_hunter' and owner_role.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_proc o join pg_namespace n on n.oid=o.pronamespace
      cross join lateral aclexplode(o.proacl) acl
      left join pg_roles grantee on grantee.oid=acl.grantee
      left join pg_roles grantor on grantor.oid=acl.grantor
     where n.nspname<>'ace_hunter'
       and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')
    union all
    select 1 from pg_type o join pg_namespace n on n.oid=o.typnamespace
      join pg_roles owner_role on owner_role.oid=o.typowner
     where n.nspname<>'ace_hunter' and owner_role.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_type o join pg_namespace n on n.oid=o.typnamespace
      cross join lateral aclexplode(o.typacl) acl
      left join pg_roles grantee on grantee.oid=acl.grantee
      left join pg_roles grantor on grantor.oid=acl.grantor
     where n.nspname<>'ace_hunter'
       and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')
  ) then
    raise exception 'Ace Hunter external Ace ownership or ACL audit failed; no cleanup was performed';
  end if;
end
$ace_external_audit$;
alter role ace_hunter_owner nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
alter role ace_hunter_migrator login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
alter role ace_hunter_runtime nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
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

do $$
begin
  if not exists (select 1 from pg_namespace where nspname='ace_hunter') then
    execute 'create schema ace_hunter authorization ace_hunter_owner';
  end if;
end
$$;
alter schema ace_hunter owner to ace_hunter_owner;
revoke all on schema ace_hunter from public;
do $$
begin
  if not exists (
    select 1 from pg_class object
      join pg_namespace namespace_object on namespace_object.oid=object.relnamespace
     where namespace_object.nspname='ace_hunter'
       and object.relkind in ('r','p','v','m','f','S')
  ) then
    revoke all on schema ace_hunter from ace_hunter_runtime;
  end if;
end
$$;

revoke all on schema auth from ace_hunter_owner, ace_hunter_migrator, ace_hunter_runtime;
revoke all on auth.users from ace_hunter_owner, ace_hunter_migrator, ace_hunter_runtime;
grant usage on schema auth to ace_hunter_owner;
grant references (id) on auth.users to ace_hunter_owner;
do $ace_acl_validate$
begin
  if exists (
    select 1
      from pg_namespace namespace_object
      cross join lateral aclexplode(namespace_object.nspacl) acl
      join pg_roles grantee on grantee.oid=acl.grantee
     where namespace_object.nspname<>'ace_hunter'
       and grantee.rolname in (
         'ace_hunter_owner','ace_hunter_migrator','ace_hunter_runtime'
       )
       and not (
         namespace_object.nspname='auth' and
         grantee.rolname='ace_hunter_owner' and acl.privilege_type='USAGE'
       )
    union all
    select 1
      from pg_class table_object
      join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
      cross join lateral aclexplode(table_object.relacl) acl
      join pg_roles grantee on grantee.oid=acl.grantee
     where namespace_object.nspname<>'ace_hunter'
       and grantee.rolname in (
         'ace_hunter_owner','ace_hunter_migrator','ace_hunter_runtime'
       )
    union all
    select 1
      from pg_attribute column_object
      join pg_class table_object on table_object.oid=column_object.attrelid
      join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
      cross join lateral aclexplode(column_object.attacl) acl
      join pg_roles grantee on grantee.oid=acl.grantee
     where namespace_object.nspname<>'ace_hunter'
       and grantee.rolname in (
         'ace_hunter_owner','ace_hunter_migrator','ace_hunter_runtime'
       )
       and not (
         namespace_object.nspname='auth' and table_object.relname='users' and
         column_object.attname='id' and grantee.rolname='ace_hunter_owner' and
         acl.privilege_type='REFERENCES'
       )
    union all
    select 1
      from pg_namespace namespace_object
      cross join lateral aclexplode(namespace_object.nspacl) acl
      join pg_roles grantor on grantor.oid=acl.grantor
     where namespace_object.nspname<>'ace_hunter' and acl.grantee=0
       and grantor.rolname like 'ace_hunter_%'
    union all
    select 1
      from pg_class table_object
      join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
      cross join lateral aclexplode(table_object.relacl) acl
      join pg_roles grantor on grantor.oid=acl.grantor
     where namespace_object.nspname<>'ace_hunter' and acl.grantee=0
       and grantor.rolname like 'ace_hunter_%'
    union all
    select 1
      from pg_attribute column_object
      join pg_class table_object on table_object.oid=column_object.attrelid
      join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
      cross join lateral aclexplode(column_object.attacl) acl
      join pg_roles grantor on grantor.oid=acl.grantor
     where namespace_object.nspname<>'ace_hunter' and acl.grantee=0
       and grantor.rolname like 'ace_hunter_%'
  ) then
    raise exception 'Ace Hunter external ACL validation failed';
  end if;
end
$ace_acl_validate$;

do $$
begin
  if has_table_privilege('ace_hunter_owner','auth.users','select') then
    raise exception 'ace_hunter_owner must not have SELECT on auth.users';
  end if;
end
$$;
