#!/usr/bin/env bash
# Separate PostgreSQL sessions compete for the same last physical stock.
# Runs only inside CI's disposable PostgreSQL service; NEVER on production.
set -euo pipefail
export PGPASSWORD="${PGPASSWORD:-postgres}"
DB="inventory_phase5b_race"
TMP="$(mktemp -d)"
cleanup() {
  psql -h 127.0.0.1 -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
psql -h 127.0.0.1 -U postgres -d postgres -X -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE ${DB};"
# The existing integration suite contains an entire synthetic inventory
# fixture, owner reconciliations and future checkout flows, rolled back by
# default. Commit it ONLY in this brand-new throwaway test database.
sed '$s/^rollback;$/commit;/' tests/inventory-multi-db.sql | \
  psql -h 127.0.0.1 -U postgres -d "$DB" -X -v ON_ERROR_STOP=1 -q >"$TMP/setup.log"

# All previous synthetic checkouts were isolated; create two fresh pending
# orders each requesting the entire available balance of one physical SKU.
psql -h 127.0.0.1 -U postgres -d "$DB" -X -v ON_ERROR_STOP=1 -q <<'SQL'
UPDATE public.internal_runtime_config
SET value=jsonb_build_object('reservation_enabled',true,'deduction_enabled',true,
  'recovery_enabled',true,'activated_at',(now()-interval '8 hours')::text)
WHERE key='inventory_checkout';
INSERT INTO public.orders(id,status,payment_status,payment_method,total,admin_notes)
VALUES ('a0000000-0000-4000-8000-000000000021','submitted','pending','PayPal',100,'Nexus Pay Now checkout'),
       ('a0000000-0000-4000-8000-000000000022','submitted','pending','PayPal',100,'Nexus Pay Now checkout');
INSERT INTO public.order_items(order_id,product_id,quantity)
SELECT o.id,'22222222-2222-4222-8222-222222222221'::uuid,
  (SELECT count(*)::integer FROM public.inventory_units
   WHERE product_id='22222222-2222-4222-8222-222222222221'
     AND state='available')
FROM public.orders o WHERE o.id IN
  ('a0000000-0000-4000-8000-000000000021',
   'a0000000-0000-4000-8000-000000000022');
DO $test$
BEGIN
  IF (SELECT quantity FROM public.order_items
      WHERE order_id='a0000000-0000-4000-8000-000000000021') NOT BETWEEN 1 AND 99 THEN
    RAISE EXCEPTION 'Race fixture must contain 1..99 available units';
  END IF;
END $test$;
SQL

# Separate database connections, launched concurrently. Row locks in the
# service-role RPC serialize the orders. Exactly one can reserve every unit.
set +e
(psql -h 127.0.0.1 -U postgres -d "$DB" -X -v ON_ERROR_STOP=1 -tAc \
  "SELECT public.core_checkout_reserve_inventory('a0000000-0000-4000-8000-000000000021')" >"$TMP/a.out" 2>"$TMP/a.err") & A=$!
(psql -h 127.0.0.1 -U postgres -d "$DB" -X -v ON_ERROR_STOP=1 -tAc \
  "SELECT public.core_checkout_reserve_inventory('a0000000-0000-4000-8000-000000000022')" >"$TMP/b.out" 2>"$TMP/b.err") & B=$!
wait "$A"; SA=$?
wait "$B"; SB=$?
set -e

if [[ "$SA" == "$SB" ]]; then
  echo "ERROR: expected exactly one competing checkout to succeed"
  cat "$TMP/a.err" "$TMP/b.err"
  exit 1
fi
if [[ "$SA" -ne 0 ]] && ! grep -q "Insufficient verified physical inventory" "$TMP/a.err"; then
  cat "$TMP/a.err"; exit 1
fi
if [[ "$SB" -ne 0 ]] && ! grep -q "Insufficient verified physical inventory" "$TMP/b.err"; then
  cat "$TMP/b.err"; exit 1
fi
psql -h 127.0.0.1 -U postgres -d "$DB" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $test$
DECLARE available_now integer;
        ordered integer;
        allocated integer;
BEGIN
  SELECT count(*) INTO available_now FROM public.inventory_units
    WHERE product_id='22222222-2222-4222-8222-222222222221'
      AND state='available';
  IF available_now<>0 THEN RAISE EXCEPTION 'Available inventory oversold or not exhausted'; END IF;

  SELECT quantity INTO ordered FROM public.order_items
    WHERE order_id='a0000000-0000-4000-8000-000000000021';
  SELECT count(*) INTO allocated FROM public.inventory_order_allocations
    WHERE order_id IN ('a0000000-0000-4000-8000-000000000021',
                       'a0000000-0000-4000-8000-000000000022')
      AND status='held';
  IF allocated<>ordered THEN
    RAISE EXCEPTION 'Competing checkouts caused duplicate or incomplete allocation';
  END IF;
  IF (SELECT count(DISTINCT order_id) FROM public.inventory_order_allocations
      WHERE order_id IN ('a0000000-0000-4000-8000-000000000021',
                         'a0000000-0000-4000-8000-000000000022'))<>1 THEN
    RAISE EXCEPTION 'More than one competing order got inventory';
  END IF;
END $test$;
SQL
echo "PASS: two concurrent checkouts, one full hold; zero oversell or partial allocations."
