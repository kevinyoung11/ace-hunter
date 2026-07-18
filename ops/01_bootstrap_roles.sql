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

do $ace_boundary_validate$
begin
  if exists (
    select 1 from pg_class o join pg_namespace n on n.oid=o.relnamespace
      join pg_roles owner_role on owner_role.oid=o.relowner
     where n.nspname<>'ace_hunter' and o.relkind='S'
       and owner_role.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_class o join pg_namespace n on n.oid=o.relnamespace
      cross join lateral aclexplode(o.relacl) acl
      left join pg_roles grantee on grantee.oid=acl.grantee
      left join pg_roles grantor on grantor.oid=acl.grantor
     where n.nspname<>'ace_hunter' and o.relkind='S'
       and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')
    union all
    select 1 from pg_proc o join pg_namespace n on n.oid=o.pronamespace
      join pg_roles owner_role on owner_role.oid=o.proowner
     where n.nspname<>'ace_hunter' and owner_role.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_type o join pg_namespace n on n.oid=o.typnamespace
      join pg_roles owner_role on owner_role.oid=o.typowner
     where n.nspname<>'ace_hunter' and owner_role.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_database o join pg_roles owner_role on owner_role.oid=o.datdba
     where o.datname=current_database() and owner_role.rolname like 'ace_hunter_%'
    union all
    select 1 from pg_proc o join pg_namespace n on n.oid=o.pronamespace
      cross join lateral aclexplode(o.proacl) acl
      left join pg_roles grantee on grantee.oid=acl.grantee
      left join pg_roles grantor on grantor.oid=acl.grantor
     where n.nspname<>'ace_hunter'
       and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')
    union all
    select 1 from pg_type o join pg_namespace n on n.oid=o.typnamespace
      cross join lateral aclexplode(o.typacl) acl
      left join pg_roles grantee on grantee.oid=acl.grantee
      left join pg_roles grantor on grantor.oid=acl.grantor
     where n.nspname<>'ace_hunter'
       and (grantee.rolname like 'ace_hunter_%' or grantor.rolname like 'ace_hunter_%')
  ) then
    raise exception 'Ace Hunter bootstrap refused: external Ace-owned high-risk object requires manual cleanup';
  end if;
end
$ace_boundary_validate$;

do $ace_acl_cleanup$
declare
  grant_row record;
  target_role text;
begin
  for grant_row in
    select namespace_object.nspname,grantor.rolname grantor_role,acl.privilege_type
      from pg_namespace namespace_object
      cross join lateral aclexplode(namespace_object.nspacl) acl
      join pg_roles grantor on grantor.oid=acl.grantor
     where acl.grantee=0 and grantor.rolname like 'ace_hunter_%'
       and namespace_object.nspname<>'ace_hunter'
  loop
    execute format('set local role %I',grant_row.grantor_role);
    execute format(
      'revoke %s on schema %I from public',
      grant_row.privilege_type,grant_row.nspname
    );
    reset role;
  end loop;

  for grant_row in
    select namespace_object.nspname,table_object.relname,
           grantor.rolname grantor_role,acl.privilege_type
      from pg_class table_object
      join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
      cross join lateral aclexplode(table_object.relacl) acl
      join pg_roles grantor on grantor.oid=acl.grantor
     where acl.grantee=0 and grantor.rolname like 'ace_hunter_%'
       and namespace_object.nspname<>'ace_hunter'
  loop
    execute format('set local role %I',grant_row.grantor_role);
    execute format(
      'revoke %s on table %I.%I from public',
      grant_row.privilege_type,grant_row.nspname,grant_row.relname
    );
    reset role;
  end loop;

  for grant_row in
    select namespace_object.nspname,table_object.relname,column_object.attname,
           grantor.rolname grantor_role,acl.privilege_type
      from pg_attribute column_object
      join pg_class table_object on table_object.oid=column_object.attrelid
      join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
      cross join lateral aclexplode(column_object.attacl) acl
      join pg_roles grantor on grantor.oid=acl.grantor
     where acl.grantee=0 and grantor.rolname like 'ace_hunter_%'
       and namespace_object.nspname<>'ace_hunter'
       and column_object.attnum>0 and not column_object.attisdropped
  loop
    execute format('set local role %I',grant_row.grantor_role);
    execute format(
      'revoke %s (%I) on table %I.%I from public',
      grant_row.privilege_type,grant_row.attname,grant_row.nspname,grant_row.relname
    );
    reset role;
  end loop;

  foreach target_role in array array[
    'ace_hunter_owner','ace_hunter_migrator','ace_hunter_runtime'
  ] loop
    for grant_row in
      select namespace_object.nspname
        from pg_namespace namespace_object
       where namespace_object.nspname<>'ace_hunter'
         and exists (
           select 1 from aclexplode(namespace_object.nspacl) acl
            where acl.grantee=(select oid from pg_roles where rolname=target_role)
         )
    loop
      execute format(
        'revoke all privileges on schema %I from %I',
        grant_row.nspname,target_role
      );
    end loop;

    for grant_row in
      select namespace_object.nspname,table_object.relname
        from pg_class table_object
        join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
       where namespace_object.nspname<>'ace_hunter'
         and exists (
           select 1 from aclexplode(table_object.relacl) acl
            where acl.grantee=(select oid from pg_roles where rolname=target_role)
         )
    loop
      execute format(
        'revoke all privileges on table %I.%I from %I',
        grant_row.nspname,grant_row.relname,target_role
      );
    end loop;

    for grant_row in
      select namespace_object.nspname,table_object.relname,column_object.attname
        from pg_attribute column_object
        join pg_class table_object on table_object.oid=column_object.attrelid
        join pg_namespace namespace_object on namespace_object.oid=table_object.relnamespace
       where namespace_object.nspname<>'ace_hunter'
         and column_object.attnum>0 and not column_object.attisdropped
         and exists (
           select 1 from aclexplode(column_object.attacl) acl
            where acl.grantee=(select oid from pg_roles where rolname=target_role)
         )
    loop
      execute format(
        'revoke all privileges (%I) on table %I.%I from %I',
        grant_row.attname,grant_row.nspname,grant_row.relname,target_role
      );
    end loop;
  end loop;
end
$ace_acl_cleanup$;
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
