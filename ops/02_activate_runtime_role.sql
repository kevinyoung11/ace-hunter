\set ON_ERROR_STOP on
\if :{?ace_hunter_runtime_password}
alter role ace_hunter_runtime login password :'ace_hunter_runtime_password';
\else
\password ace_hunter_runtime
alter role ace_hunter_runtime login;
\endif
