import { describe, expect, it } from "vitest";
import { applyExactBootstrapDelta, assertCatalogEqualExceptAceRoles, canonicalizeCatalog, type Catalog } from "../../../scripts/supabase-safety-check.js";

const base = {
  schemas: [{ name: "auth", owner: "supabase_admin" }],
  relations: [{ schema_name: "auth", relation_name: "users", owner: "supabase_auth_admin" }],
  columns: [{ table_schema: "auth", table_name: "users", ordinal_position: 1, column_name: "id" }],
  constraints: [], indexes: [], policies: [], routines: [], triggers: [], types: [], extensions: [],
  roles: [{ rolname: "postgres", rolsuper: true, rolinherit: true, rolcreaterole: true, rolcreatedb: true, rolcanlogin: true, rolreplication: true, rolbypassrls: true }],
  memberships: [], schema_grants: [], relation_grants: [], column_grants: [], database_grants: [], default_grants: [],
  session_identity: [{ name: "postgres" }],
};

describe("Supabase administrator fingerprint", () => {
  it("accepts only the exact reviewed bootstrap delta in either input order", () => {
    const after = applyExactBootstrapDelta(base);
    after.roles.reverse();
    expect(() => assertCatalogEqualExceptAceRoles(base, after)).not.toThrow();
    expect(canonicalizeCatalog(after)).toEqual(canonicalizeCatalog(applyExactBootstrapDelta(base)));
  });

  it.each([
    ["extra schema", (c: Catalog) => c.schemas.push({ name: "escape", owner: "postgres" })],
    ["missing non-Ace row", (c: Catalog) => c.columns.pop()],
    ["extra membership", (c: Catalog) => c.memberships.push({ role_name: "ace_hunter_owner", member_name: "ace_hunter_runtime", admin_option: false })],
    ["extra external grant", (c: Catalog) => c.relation_grants.push({ schema_name: "public", relation_name: "x", grantee: "ace_hunter_owner", privilege: "SELECT", is_grantable: false })],
    ["wrong role tuple", (c: Catalog) => { const row = c.roles.find((item) => item.rolname === "ace_hunter_runtime"); if (row) row.rolsuper = true; }],
  ])("rejects %s", (_name, mutate) => {
    const after = applyExactBootstrapDelta(base);
    mutate(after);
    expect(() => assertCatalogEqualExceptAceRoles(base, after)).toThrow("administrator_catalog_changed");
  });

  it("rejects creator-admin memberships not bound to the recorded administrator", () => {
    const after = applyExactBootstrapDelta(base);
    for (const role_name of ["ace_hunter_owner", "ace_hunter_migrator", "ace_hunter_runtime"]) {
      after.memberships.push({ role_name, member_name: "evil", grantor_name: "supabase_admin", admin_option: true, inherit_option: false, set_option: false });
    }
    expect(() => assertCatalogEqualExceptAceRoles(base, after)).toThrow("administrator_catalog_changed");
  });
});
