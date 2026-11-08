-- Manual, evidence-backed historical financial reconciliation.
-- Original orders, payments, and sale-time cost snapshots are NEVER overwritten.
-- Both evidence tables are owner/admin-only through an audited RPC.
CREATE TABLE public.core_finance_cost_evidence (
  order_item_id uuid PRIMARY KEY REFERENCES public.order_items(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_cost numeric(12,2) NOT NULL CHECK (unit_cost >= 0 AND unit_cost <= 1000000),
  line_cost numeric(12,2) NOT NULL CHECK (line_cost >= 0),
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 6 AND 200),
  explanation text CHECK (explanation IS NULL OR length(explanation) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT
);
CREATE INDEX core_finance_cost_evidence_order_idx ON public.core_finance_cost_evidence(order_id);
CREATE TABLE public.core_finance_paid_date_evidence (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE RESTRICT,
  effective_paid_at timestamptz NOT NULL,
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 6 AND 200),
  explanation text CHECK (explanation IS NULL OR length(explanation) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT
);
ALTER TABLE public.core_finance_cost_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.core_finance_paid_date_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.core_finance_cost_evidence FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON TABLE public.core_finance_paid_date_evidence FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.core_finance_cost_evidence,public.core_finance_paid_date_evidence TO service_role;

CREATE OR REPLACE FUNCTION public.core_finance_record_evidence(
  p_kind text, p_target_id uuid, p_unit_cost numeric, p_effective_paid_at timestamptz,
  p_evidence_reference text, p_explanation text, p_expected_updated_at timestamptz,
  p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE
 v_actor_role text; v_actor_email text;
 v_old jsonb; v_new jsonb; v_current_version timestamptz;
 v_order_id uuid; v_quantity integer;
 v_paid_at timestamptz; v_created_at timestamptz;
 v_payment_status text; v_existing_line_cost numeric;
 v_ref text := btrim(coalesce(p_evidence_reference,''));
 v_explanation text := nullif(btrim(coalesce(p_explanation,'')),'');
 v_now timestamptz := clock_timestamp();
BEGIN
 SELECT lower(coalesce(u.raw_app_meta_data->>'role','')),u.email
   INTO v_actor_role,v_actor_email FROM auth.users u WHERE u.id=p_actor_id;
 IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner','admin') THEN
   RAISE EXCEPTION 'Core owner/admin access required';
 END IF;
 IF p_kind NOT IN ('historical_cost','payment_date') OR p_target_id IS NULL THEN
   RAISE EXCEPTION 'Choose an eligible reconciliation record';
 END IF;
 IF length(v_ref) NOT BETWEEN 6 AND 200 OR length(coalesce(v_explanation,''))>1000 THEN
   RAISE EXCEPTION 'Evidence reference (6-200 characters) and explanation (max 1000) required';
 END IF;
 IF p_kind='historical_cost' THEN
   SELECT oi.order_id,oi.quantity,o.payment_status,c.line_cost
      INTO v_order_id,v_quantity,v_payment_status,v_existing_line_cost
   FROM public.order_items oi
   JOIN public.orders o ON o.id=oi.order_id
   LEFT JOIN public.order_item_costs c ON c.order_item_id=oi.id
   WHERE oi.id=p_target_id FOR UPDATE OF oi;
   IF v_order_id IS NULL OR v_payment_status <> 'paid'
     OR v_existing_line_cost IS NOT NULL THEN
     RAISE EXCEPTION 'Only paid items missing an original sale-time cost can be reconciled';
   END IF;
   IF p_unit_cost IS NULL OR p_unit_cost<0 OR p_unit_cost>1000000
      OR round(p_unit_cost,2)<>p_unit_cost OR v_quantity<1 THEN
     RAISE EXCEPTION 'Enter an evidenced USD unit cost with two decimals';
   END IF;
   IF p_effective_paid_at IS NOT NULL THEN RAISE EXCEPTION 'Unexpected payment date'; END IF;
   SELECT to_jsonb(e),e.updated_at INTO v_old,v_current_version
     FROM public.core_finance_cost_evidence e WHERE e.order_item_id=p_target_id FOR UPDATE;
   IF (v_old IS NULL AND p_expected_updated_at IS NOT NULL) OR
      (v_old IS NOT NULL AND p_expected_updated_at IS DISTINCT FROM v_current_version) THEN
     RAISE EXCEPTION 'Review changed since you opened it; refresh';
   END IF;
   INSERT INTO public.core_finance_cost_evidence(
      order_item_id,order_id,quantity,unit_cost,line_cost,evidence_reference,
      explanation,created_by,updated_by)
   VALUES (p_target_id,v_order_id,v_quantity,p_unit_cost,round(p_unit_cost*v_quantity,2),
      v_ref,v_explanation,p_actor_id,p_actor_id)
   ON CONFLICT (order_item_id) DO UPDATE SET
      unit_cost=excluded.unit_cost,line_cost=excluded.line_cost,
      quantity=excluded.quantity,evidence_reference=excluded.evidence_reference,
      explanation=excluded.explanation,updated_at=v_now,updated_by=p_actor_id
   RETURNING to_jsonb(core_finance_cost_evidence) INTO v_new;
 ELSE
   SELECT o.paid_at,o.created_at,o.payment_status
     INTO v_paid_at,v_created_at,v_payment_status FROM public.orders o
     WHERE o.id=p_target_id FOR UPDATE;
   IF NOT FOUND OR v_payment_status <> 'paid' OR v_paid_at IS NOT NULL THEN
     RAISE EXCEPTION 'Only paid orders missing their original paid date can be reconciled';
   END IF;
   IF p_unit_cost IS NOT NULL THEN RAISE EXCEPTION 'Unexpected unit cost'; END IF;
   IF p_effective_paid_at IS NULL OR p_effective_paid_at > v_now
     OR p_effective_paid_at < timestamptz '2020-01-01T00:00:00Z' THEN
     RAISE EXCEPTION 'Choose a documented historical payment date, not a future date';
   END IF;
   SELECT to_jsonb(e),e.updated_at INTO v_old,v_current_version
     FROM public.core_finance_paid_date_evidence e WHERE e.order_id=p_target_id FOR UPDATE;
   IF (v_old IS NULL AND p_expected_updated_at IS NOT NULL) OR
      (v_old IS NOT NULL AND p_expected_updated_at IS DISTINCT FROM v_current_version) THEN
     RAISE EXCEPTION 'Review changed since you opened it; refresh';
   END IF;
   INSERT INTO public.core_finance_paid_date_evidence(
     order_id,effective_paid_at,evidence_reference,explanation,created_by,updated_by)
   VALUES (p_target_id,p_effective_paid_at,v_ref,v_explanation,p_actor_id,p_actor_id)
   ON CONFLICT (order_id) DO UPDATE SET
     effective_paid_at=excluded.effective_paid_at,evidence_reference=excluded.evidence_reference,
     explanation=excluded.explanation,updated_at=v_now,updated_by=p_actor_id
   RETURNING to_jsonb(core_finance_paid_date_evidence) INTO v_new;
 END IF;
 INSERT INTO public.core_audit_events(
    actor_user_id,actor_email,actor_role,action,entity_type,entity_id,
    before_data,after_data,metadata
 ) VALUES (p_actor_id,v_actor_email,v_actor_role,'finance.reconcile.'||p_kind,
    p_kind,p_target_id::text,v_old,v_new,
    jsonb_build_object('source','core','evidence_required',true,'original_records_unchanged',true));
 RETURN v_new;
END;
$fn$;
REVOKE ALL ON FUNCTION public.core_finance_record_evidence(text,uuid,numeric,timestamptz,text,text,timestamptz,uuid)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_finance_record_evidence(text,uuid,numeric,timestamptz,text,text,timestamptz,uuid)
TO service_role;
