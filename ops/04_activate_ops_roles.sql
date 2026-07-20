\set ON_ERROR_STOP on
-- Passwords are supplied interactively or by the deployment secret manager.
\password ace_hunter_ops
\password ace_hunter_github_runtime
\password ace_hunter_mac_worker
alter role ace_hunter_ops login;
alter role ace_hunter_github_runtime login;
alter role ace_hunter_mac_worker login;
