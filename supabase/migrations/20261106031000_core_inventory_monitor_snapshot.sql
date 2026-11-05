-- Core Phase 5C: read-only, server-role-only inventory payment monitoring.
-- No changes to orders, payments, unit state, movements, stock counts, or flags.
-- New function deliberately has no browser EXECUTE privilege. Core's existing
-- owner-authenticated Edge Function is the only customer-facing entry point.
CREATE OR REPLACE FUNCTION public.core_inventory_monitor_snapshot()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $monitor$
WITH cfg AS (
  SELECT COALESCE(
    (SELECT value FROM public.internal_runtime_config WHERE key='inventory_checkout'),
    '{"reservation_enabled":false,"deduction_enabled":false,"recovery_enabled":false,"activated_at":null}'::jsonb
  ) AS flags
),
cutover AS (
  SELECT flags, NULLIF(flags->>'activated_at','')::timestamptz AS starts_at FROM cfg
),
scoped_orders AS (
  SELECT o.id,o.order_number,o.status,o.payment_status,o.payment_method,
    o.total,o.customer_id,o.created_at,o.paid_at,o.updated_at
  FROM public.orders o CROSS JOIN cutover c
  WHERE c.starts_at IS NOT NULL AND o.created_at >= c.starts_at
    AND COALESCE(o.admin_notes,'') LIKE 'Nexus Pay Now checkout%'
),
order_metrics AS (
  SELECT o.*,
    COALESCE((
      SELECT SUM(i.quantity)::integer
      FROM public.order_items i
      JOIN public.inventory_product_settings sp ON sp.product_id=i.product_id
      WHERE i.order_id=o.id AND sp.supply_mode='physical'
    ),0) AS expected_physical_units,
    (SELECT COUNT(*)::integer FROM public.inventory_order_allocations a
      WHERE a.order_id=o.id AND a.status='held') AS held_units,
    (SELECT COUNT(*)::integer FROM public.inventory_order_allocations a
      WHERE a.order_id=o.id AND a.status='committed') AS committed_units,
    (SELECT COUNT(*)::integer FROM public.inventory_order_allocations a
      WHERE a.order_id=o.id AND a.status='released') AS released_units,
    (SELECT MIN(a.reserved_at) FROM public.inventory_order_allocations a
      WHERE a.order_id=o.id AND a.status='held') AS first_held_at,
    EXISTS(SELECT 1 FROM public.payments p WHERE p.order_id=o.id) AS has_payment_record,
    EXISTS(
      SELECT 1 FROM public.payments p
      WHERE p.order_id=o.id AND p.status='verified' AND p.paid_at IS NOT NULL
        AND p.amount=o.total AND p.provider=o.payment_method
        AND p.customer_id IS NOT DISTINCT FROM o.customer_id
        AND (o.payment_method NOT IN ('PayPal','Venmo','Apple Pay','Card')
          OR NULLIF(p.provider_capture_id,'') IS NOT NULL)
    ) AS verified_payment,
    (SELECT COUNT(*)::integer
       FROM public.inventory_order_allocations a
       JOIN public.inventory_units u ON u.id=a.unit_id
       WHERE a.order_id=o.id
         AND ((a.status='held' AND u.state<>'reserved')
           OR (a.status='committed' AND u.state NOT IN ('allocated','shipped'))))
      AS state_conflicts
  FROM scoped_orders o
),
issues AS (
  SELECT 'paid_stock_gap'::text AS code,'critical'::text AS severity,
    o.id AS order_id,o.order_number,o.created_at AS first_seen,
    'Paid order not fully allocated'::text AS title,
    'Verify the captured payment and reconcile the missing physical allocations before fulfillment.'::text AS next_action,
    o.expected_physical_units AS expected_units,o.committed_units AS actual_units
  FROM order_metrics o
  WHERE o.payment_status='paid' AND o.expected_physical_units>0
    AND o.committed_units<>o.expected_physical_units
    AND COALESCE(o.paid_at,o.updated_at,o.created_at)<now()-interval '2 minutes'
  UNION ALL
  SELECT 'paid_payment_mismatch','critical',o.id,o.order_number,o.created_at,
    'Paid order lacks matching verified payment',
    'Check provider capture, amount, and payment status; do not deduct stock until verified.',
    o.expected_physical_units,o.committed_units
  FROM order_metrics o
  WHERE o.payment_status='paid' AND o.expected_physical_units>0
    AND NOT o.verified_payment
    AND COALESCE(o.paid_at,o.updated_at,o.created_at)<now()-interval '2 minutes'
  UNION ALL
  SELECT 'inventory_state_conflict','critical',o.id,o.order_number,o.created_at,
    'Tracked unit and reservation status disagree',
    'Investigate held/committed unit states before releasing or fulfilling.',
    o.expected_physical_units,o.committed_units
  FROM order_metrics o WHERE o.state_conflicts>0
  UNION ALL
  SELECT 'expired_still_held','critical',o.id,o.order_number,o.created_at,
    'Expired checkout still holds stock',
    'Inspect the cancellation/release workflow; do not manually alter units without reconciliation.',
    o.expected_physical_units,o.held_units
  FROM order_metrics o WHERE o.status='checkout_expired' AND o.held_units>0
  UNION ALL
  SELECT 'paid_released_stock','critical',o.id,o.order_number,o.created_at,
    'Paid order has released inventory',
    'Confirm payment and investigate released allocation before allowing new sale.',
    o.expected_physical_units,o.released_units
  FROM order_metrics o WHERE o.payment_status='paid' AND o.released_units>0
  UNION ALL
  SELECT 'stale_no_payment','warning',o.id,o.order_number,o.created_at,
    'Abandoned checkout holding inventory',
    'Eligible for provider-safe expiry review if the recovery flag is later enabled.',
    o.expected_physical_units,o.held_units
  FROM order_metrics o
  WHERE o.held_units>0 AND o.payment_status<>'paid'
    AND o.status='submitted' AND o.payment_status='pending'
    AND NOT o.has_payment_record AND o.first_held_at<now()-interval '90 minutes'
    AND o.created_at<now()-interval '90 minutes'
  UNION ALL
  SELECT 'provider_session_review','warning',o.id,o.order_number,o.created_at,
    'Stale checkout has a payment session',
    'Check the payment provider before releasing inventory. Never auto-restock an unknown capture.',
    o.expected_physical_units,o.held_units
  FROM order_metrics o
  WHERE o.held_units>0 AND o.payment_status<>'paid'
    AND o.has_payment_record AND o.first_held_at<now()-interval '90 minutes'
),
unit_orphans AS (
  SELECT COUNT(*)::integer AS orphan_count
  FROM public.inventory_units u
  WHERE u.state='reserved'
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory_order_allocations a
       WHERE a.unit_id=u.id AND a.status='held'
    )
),
issue_list AS (
  SELECT * FROM issues
  UNION ALL
  SELECT 'unlinked_reservation','critical',NULL::uuid,NULL::text,now(),
    'Reserved units have no active order allocation',
    'Investigate orphaned physical reservations before switching inventory automation on.',
    orphan_count,0
  FROM unit_orphans WHERE orphan_count>0
),
aggregated AS (
  SELECT COUNT(*)::integer AS total,
    COUNT(*) FILTER(WHERE severity='critical')::integer AS critical,
    COUNT(*) FILTER(WHERE severity='warning')::integer AS warnings
  FROM issue_list
)
SELECT jsonb_build_object(
  'checked_at',NOW(),
  'flags',(SELECT flags FROM cutover),
  'totals',(SELECT jsonb_build_object('total',total,'critical',critical,'warning',warnings)
    FROM aggregated),
  'metrics',jsonb_build_object(
    'held_units',(SELECT COUNT(*) FROM public.inventory_order_allocations WHERE status='held'),
    'committed_units',(SELECT COUNT(*) FROM public.inventory_order_allocations WHERE status='committed'),
    'open_physical_lots_without_verified_count',(
      SELECT COUNT(*) FROM public.inventory_lots l
      WHERE EXISTS(SELECT 1 FROM public.inventory_units u WHERE u.lot_id=l.id)
        AND NOT EXISTS(SELECT 1 FROM public.inventory_stock_counts sc
          WHERE sc.lot_id=l.id AND sc.status IN ('matched','resolved'))
    ),
    'pending_reconciliation',(
      SELECT COUNT(*) FROM public.inventory_stock_counts WHERE status='pending'
    )
  ),
  'alerts',COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'code',a.code,'severity',a.severity,'order_id',a.order_id,
      'order_number',a.order_number,'first_seen',a.first_seen,
      'title',a.title,'next_action',a.next_action,
      'expected_units',a.expected_units,'actual_units',a.actual_units
    ) ORDER BY (CASE WHEN a.severity='critical' THEN 0 ELSE 1 END),a.first_seen,a.code)
    FROM (
      SELECT * FROM issue_list
      ORDER BY (CASE WHEN severity='critical' THEN 0 ELSE 1 END),first_seen,code
      LIMIT 50
    ) a
  ),'[]'::jsonb)
);
$monitor$;

-- Defense-in-depth: not callable from anon, authenticated, or PUBLIC even
-- if PostgREST exposes this function under the public schema.
REVOKE ALL ON FUNCTION public.core_inventory_monitor_snapshot()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_inventory_monitor_snapshot() TO service_role;

DO $verify$
BEGIN
  IF has_function_privilege('anon',
       'public.core_inventory_monitor_snapshot()','EXECUTE') OR
     has_function_privilege('authenticated',
       'public.core_inventory_monitor_snapshot()','EXECUTE') THEN
    RAISE EXCEPTION 'Owner monitoring function is exposed to customer roles';
  END IF;
  IF (SELECT COALESCE((value->>'reservation_enabled')::boolean,false) OR
             COALESCE((value->>'deduction_enabled')::boolean,false) OR
             COALESCE((value->>'recovery_enabled')::boolean,false)
      FROM public.internal_runtime_config WHERE key='inventory_checkout') THEN
    RAISE EXCEPTION 'Monitor migration cannot run while stock automation is enabled';
  END IF;
END $verify$;
