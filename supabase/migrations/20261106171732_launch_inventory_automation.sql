-- Core ↔ Nexus production inventory launch.
-- This migration is intentionally self-guarding: it aborts before changing
-- classifications or flags if production is no longer in the accepted state.

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.internal_runtime_config
    WHERE key='inventory_checkout' AND (
      COALESCE((value->>'reservation_enabled')::boolean,false) OR
      COALESCE((value->>'deduction_enabled')::boolean,false) OR
      COALESCE((value->>'recovery_enabled')::boolean,false) OR
      NULLIF(value->>'activated_at','') IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Inventory automation is not in the expected pre-launch state';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.products p
    LEFT JOIN public.inventory_product_settings s ON s.product_id=p.id
    WHERE p.active AND s.product_id IS NULL AND (
      EXISTS (SELECT 1 FROM public.inventory_units u WHERE u.product_id=p.id) OR
      EXISTS (SELECT 1 FROM public.inventory_lots l WHERE l.product_id=p.id)
    )
  ) THEN
    RAISE EXCEPTION 'An unclassified active product has tracked physical stock';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.inventory_lots l
    WHERE EXISTS (SELECT 1 FROM public.inventory_units u WHERE u.lot_id=l.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.inventory_stock_counts sc
        WHERE sc.lot_id=l.id AND sc.status IN ('matched','resolved')
      )
  ) THEN
    RAISE EXCEPTION 'A tracked lot lacks a verified physical count';
  END IF;

  IF EXISTS (SELECT 1 FROM public.inventory_order_allocations) OR
     EXISTS (SELECT 1 FROM public.inventory_units WHERE state='reserved') THEN
    RAISE EXCEPTION 'Pre-launch inventory holds or allocations exist';
  END IF;
END
$preflight$;

-- Every active product without tracked physical stock has historically been
-- fulfilled outside Core. Classify those products as vendor supplied so the
-- physical reservation engine never deducts nonexistent local units.
INSERT INTO public.inventory_product_settings(product_id,supply_mode,reorder_point)
SELECT p.id,'vendor',0
FROM public.products p
WHERE p.active
  AND NOT EXISTS (
    SELECT 1 FROM public.inventory_product_settings s WHERE s.product_id=p.id
  );

DO $classification_check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.products p
    LEFT JOIN public.inventory_product_settings s ON s.product_id=p.id
    WHERE p.active AND (s.product_id IS NULL OR s.supply_mode='unreviewed')
  ) THEN
    RAISE EXCEPTION 'Every active product must have a reviewed supply mode';
  END IF;
END
$classification_check$;

UPDATE public.internal_runtime_config
SET value = value || jsonb_build_object(
  'reservation_enabled',true,
  'deduction_enabled',true,
  'recovery_enabled',true,
  'activated_at',statement_timestamp()
), updated_at=statement_timestamp()
WHERE key='inventory_checkout';

DO $schedule$
DECLARE existing_job bigint;
BEGIN
  FOR existing_job IN
    SELECT jobid FROM cron.job WHERE jobname='core-inventory-recovery-15m'
  LOOP
    PERFORM cron.unschedule(existing_job);
  END LOOP;
END
$schedule$;

SELECT cron.schedule(
  'core-inventory-recovery-15m',
  '*/15 * * * *',
  $job$SELECT public.core_checkout_recover_abandoned(25,90);$job$
);

DO $verify$
DECLARE cfg jsonb;
BEGIN
  SELECT value INTO cfg FROM public.internal_runtime_config
  WHERE key='inventory_checkout';

  IF NOT COALESCE((cfg->>'reservation_enabled')::boolean,false) OR
     NOT COALESCE((cfg->>'deduction_enabled')::boolean,false) OR
     NOT COALESCE((cfg->>'recovery_enabled')::boolean,false) OR
     NULLIF(cfg->>'activated_at','') IS NULL THEN
    RAISE EXCEPTION 'Inventory automation activation verification failed';
  END IF;

  IF (SELECT count(*) FROM cron.job
      WHERE jobname='core-inventory-recovery-15m' AND active) <> 1 THEN
    RAISE EXCEPTION 'Inventory recovery schedule verification failed';
  END IF;
END
$verify$;
