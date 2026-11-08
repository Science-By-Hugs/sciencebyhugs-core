-- Add an explicitly tracked outbound fulfillment/shipping cost category.
-- Do not classify inbound vendor freight as operating expense or COGS twice.
ALTER TABLE public.core_finance_expenses
 DROP CONSTRAINT core_finance_expenses_category_check;
ALTER TABLE public.core_finance_expenses
 ADD CONSTRAINT core_finance_expenses_category_check CHECK (category IN (
   'inventory_purchase','vendor_shipping','fulfillment_shipping','processing_fee',
   'software','marketing','packaging','supplies','operations','other'
 ));
CREATE OR REPLACE FUNCTION public.core_manage_finance_expense(p_action text, p_payload jsonb, p_expected_updated_at timestamp with time zone, p_actor_id uuid, p_confirmation text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor_role text;
  v_actor_email text;
  v_old public.core_finance_expenses%ROWTYPE;
  v_new public.core_finance_expenses%ROWTYPE;
  v_id uuid;
  v_date date;
  v_category text;
  v_vendor_id uuid;
  v_po_id uuid;
  v_po_vendor_id uuid;
  v_payee text;
  v_amount numeric;
  v_method text;
  v_reference text;
  v_notes text;
  v_status text;
BEGIN
  SELECT lower(coalesce(u.raw_app_meta_data->>'role','')), u.email
    INTO v_actor_role,v_actor_email FROM auth.users u WHERE u.id=p_actor_id;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'Core owner/admin access required';
  END IF;
  IF p_action NOT IN ('create','update','void')
      OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid expense operation';
  END IF;

  IF p_action IN ('update','void') THEN
    IF coalesce(p_payload->>'id','') = '' OR p_expected_updated_at IS NULL THEN
      RAISE EXCEPTION 'Expense ID and version required';
    END IF;
    v_id := (p_payload->>'id')::uuid;
    SELECT * INTO v_old FROM public.core_finance_expenses
      WHERE id=v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
    IF v_old.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'Expense changed elsewhere; reload and retry';
    END IF;
    IF v_old.status='voided' THEN
      RAISE EXCEPTION 'Voided expenses cannot be changed';
    END IF;
  ELSIF p_payload ? 'id' THEN
    RAISE EXCEPTION 'New expenses cannot have an existing ID';
  END IF;

  IF p_action='void' THEN
    IF p_confirmation IS DISTINCT FROM 'VOID' THEN
      RAISE EXCEPTION 'Type VOID to confirm';
    END IF;
    UPDATE public.core_finance_expenses
       SET status='voided', voided_at=clock_timestamp(),
           updated_at=clock_timestamp(), updated_by=p_actor_id
     WHERE id=v_id RETURNING * INTO v_new;
  ELSE
    IF (p_payload->>'expense_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'Use a valid YYYY-MM-DD expense date';
    END IF;
    v_date := (p_payload->>'expense_date')::date;
    IF to_char(v_date,'YYYY-MM-DD') IS DISTINCT FROM (p_payload->>'expense_date') THEN
      RAISE EXCEPTION 'Invalid expense date';
    END IF;
    v_category := btrim(coalesce(p_payload->>'category',''));
    IF v_category NOT IN ('inventory_purchase','vendor_shipping','fulfillment_shipping','processing_fee',
        'software','marketing','packaging','supplies','operations','other') THEN
      RAISE EXCEPTION 'Choose a valid expense category';
    END IF;
    v_status := btrim(coalesce(p_payload->>'status',''));
    IF v_status NOT IN ('planned','paid') THEN
      RAISE EXCEPTION 'Choose planned or paid';
    END IF;
    v_method := btrim(coalesce(p_payload->>'payment_method','other'));
    IF v_method NOT IN ('card','bank_transfer','paypal','zelle','cash','crypto','other') THEN
      RAISE EXCEPTION 'Choose a valid payment method';
    END IF;
    IF coalesce(p_payload->>'amount','') !~ '^[0-9]{1,7}([.][0-9]{1,2})?$' THEN
      RAISE EXCEPTION 'Amount must be a positive USD amount with at most two decimals';
    END IF;
    v_amount := (p_payload->>'amount')::numeric;
    IF v_amount <= 0 OR v_amount > 1000000 THEN
      RAISE EXCEPTION 'Amount is outside allowed range';
    END IF;
    v_vendor_id := NULLIF(p_payload->>'vendor_id','')::uuid;
    v_po_id := NULLIF(p_payload->>'purchase_order_id','')::uuid;
    IF v_po_id IS NOT NULL THEN
      SELECT vendor_id INTO v_po_vendor_id
        FROM public.inventory_purchase_orders WHERE id=v_po_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
      IF v_vendor_id IS NOT NULL AND v_vendor_id <> v_po_vendor_id THEN
        RAISE EXCEPTION 'Vendor does not match the linked purchase order';
      END IF;
      v_vendor_id := v_po_vendor_id;
    END IF;
    IF v_vendor_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.inventory_vendors WHERE id=v_vendor_id
    ) THEN
      RAISE EXCEPTION 'Vendor not found';
    END IF;
    v_payee := btrim(coalesce(p_payload->>'payee',''));
    IF v_payee='' AND v_vendor_id IS NOT NULL THEN
      SELECT name INTO v_payee FROM public.inventory_vendors WHERE id=v_vendor_id;
    END IF;
    IF length(v_payee) NOT BETWEEN 1 AND 120 THEN
      RAISE EXCEPTION 'Payee must be 1–120 characters';
    END IF;
    v_reference := NULLIF(btrim(coalesce(p_payload->>'reference_number','')),'');
    v_notes := NULLIF(btrim(coalesce(p_payload->>'notes','')),'');
    IF length(coalesce(v_reference,''))>120 OR length(coalesce(v_notes,''))>1000 THEN
      RAISE EXCEPTION 'Reference or notes are too long';
    END IF;

    IF p_action='create' THEN
      INSERT INTO public.core_finance_expenses(
        expense_date,category,vendor_id,purchase_order_id,payee,amount,
        payment_method,reference_number,notes,status,created_by,updated_by
      ) VALUES (
        v_date,v_category,v_vendor_id,v_po_id,v_payee,v_amount,
        v_method,v_reference,v_notes,v_status,p_actor_id,p_actor_id
      ) RETURNING * INTO v_new;
    ELSE
      UPDATE public.core_finance_expenses
         SET expense_date=v_date,category=v_category,vendor_id=v_vendor_id,
             purchase_order_id=v_po_id,payee=v_payee,amount=v_amount,
             payment_method=v_method,reference_number=v_reference,
             notes=v_notes,status=v_status,updated_by=p_actor_id,
             updated_at=clock_timestamp()
       WHERE id=v_id RETURNING * INTO v_new;
    END IF;
  END IF;

  INSERT INTO public.core_audit_events(
    actor_user_id,actor_email,actor_role,action,entity_type,entity_id,
    before_data,after_data,metadata
  ) VALUES (
    p_actor_id,v_actor_email,v_actor_role,'finance.expense.'||p_action,
    'finance_expense',v_new.id::text,
    CASE WHEN p_action='create' THEN NULL ELSE to_jsonb(v_old) END,
    to_jsonb(v_new),
    jsonb_build_object('source','core','manual_entry',true,'no_ledger_import',true)
  );
  RETURN to_jsonb(v_new);
END;
$function$;

REVOKE ALL ON FUNCTION public.core_manage_finance_expense(text,jsonb,timestamptz,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_manage_finance_expense(text,jsonb,timestamptz,uuid,text) TO service_role;
