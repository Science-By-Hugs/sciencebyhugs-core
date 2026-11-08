-- Narrow the default Supabase service-role grant on the expense ledger.
-- Only its audited RPC may mutate amounts/voids; Edge may SELECT for reporting.
REVOKE ALL ON TABLE public.core_finance_expenses FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.core_finance_expenses TO service_role;
-- Explicitly no DELETE or TRUNCATE to service_role. anon/authenticated have no table grants.
