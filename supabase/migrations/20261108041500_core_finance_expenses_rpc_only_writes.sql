-- The Edge API reads the ledger through service_role, but all changes
-- must pass the actor-verified, audited SECURITY DEFINER RPC.
REVOKE INSERT, UPDATE ON TABLE public.core_finance_expenses FROM service_role;
-- service_role retains SELECT only; RPC owner (postgres) retains write access.
