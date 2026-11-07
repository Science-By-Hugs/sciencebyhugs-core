-- Register an exact owner-confirmed on-hand count without fabricating stock
-- through a kit-multiple purchase order. Creates a real PO snapshot, receipt,
-- lot, individually tracked units and immutable receipt movements atomically.
-- Existing units are never modified, and duplicate supplier lot entry is rejected.
CREATE OR REPLACE FUNCTION public.core_inventory_register_current_stock(
  p_product_id uuid,p_vendor_id uuid,p_total integer,p_damaged integer,
  p_unit_cost numeric,p_shipping numeric,p_fees numeric,
  p_supplier_lot text,p_expiry date,p_request_id uuid,p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE
  v_mode text;
  v_vendor_active boolean;
  v_offer uuid;
  v_po public.inventory_purchase_orders%rowtype;
  v_payload jsonb;
  v_receipt jsonb;
BEGIN
  IF p_product_id IS NULL OR p_vendor_id IS NULL OR p_actor_id IS NULL
     OR p_request_id IS NULL OR p_total IS NULL OR p_total NOT BETWEEN 1 AND 100
     OR p_damaged IS NULL OR p_damaged NOT BETWEEN 0 AND p_total
     OR p_unit_cost IS NULL OR p_unit_cost<=0 OR p_unit_cost>100000
     OR round(p_unit_cost,2)<>p_unit_cost
     OR p_shipping IS NULL OR p_shipping<0 OR p_shipping>1000000
     OR round(p_shipping,2)<>p_shipping
     OR p_fees IS NULL OR p_fees<0 OR p_fees>1000000
     OR round(p_fees,2)<>p_fees
     OR length(btrim(coalesce(p_supplier_lot,''))) NOT BETWEEN 1 AND 120
  THEN RAISE EXCEPTION 'Enter a product, vendor, 1–100 units, accurate costs and a supplier lot'; END IF;
  IF p_expiry<CURRENT_DATE AND p_total>p_damaged THEN
    RAISE EXCEPTION 'Expired units cannot be entered as available stock';
  END IF;
  -- Serialize manual receipts for a product; do not race the checkout lot locks.
  SELECT supply_mode INTO v_mode FROM public.inventory_product_settings
    WHERE product_id=p_product_id FOR UPDATE;
  IF v_mode IS DISTINCT FROM 'physical' THEN
    RAISE EXCEPTION 'Classify the product as physical before registering units';
  END IF;
  SELECT active INTO v_vendor_active FROM public.inventory_vendors WHERE id=p_vendor_id;
  IF v_vendor_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Choose an active inventory vendor';
  END IF;
  v_payload:=jsonb_build_object(
    'source','core_manual_onhand','product_id',p_product_id,'vendor_id',p_vendor_id,
    'total',p_total,'damaged',p_damaged,'unit_cost',p_unit_cost,
    'shipping',p_shipping,'fees',p_fees,'supplier_lot',btrim(p_supplier_lot),
    'expiry',p_expiry,'actor_id',p_actor_id
  );
  SELECT * INTO v_po FROM public.inventory_purchase_orders
    WHERE request_id=p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_po.request_payload IS DISTINCT FROM v_payload THEN
      RAISE EXCEPTION 'Stock request key reused with different counts';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.inventory_lots l
      WHERE l.product_id=p_product_id AND l.vendor_id=p_vendor_id
        AND l.supplier_lot=btrim(p_supplier_lot)
    ) THEN
      RAISE EXCEPTION 'This product/vendor supplier lot is already tracked. Count that lot instead of duplicating it.';
    END IF;
    -- A linked offer is necessary for the existing audited PO schema.
    -- Its quote is never overwritten: the line snapshots this manually
    -- verified on-hand cost at one unit per pack, even for ten-unit kit vendors.
    SELECT id INTO v_offer FROM public.inventory_vendor_offers
      WHERE vendor_id=p_vendor_id AND product_id=p_product_id
      ORDER BY active DESC,updated_at DESC LIMIT 1;
    IF v_offer IS NULL THEN
      INSERT INTO public.inventory_vendor_offers(
        vendor_id,product_id,units_per_pack,price_per_pack,estimated_inbound_shipping,
        vendor_sku,active
      ) VALUES(p_vendor_id,p_product_id,1,p_unit_cost,0,'CORE-ONHAND',true)
      ON CONFLICT(vendor_id,product_id,units_per_pack) DO NOTHING
      RETURNING id INTO v_offer;
      IF v_offer IS NULL THEN
        SELECT id INTO v_offer FROM public.inventory_vendor_offers
          WHERE vendor_id=p_vendor_id AND product_id=p_product_id
            AND units_per_pack=1;
      END IF;
    END IF;
    INSERT INTO public.inventory_purchase_orders(
      vendor_id,request_id,shipping_actual,fees_actual,notes,created_by,request_payload
    ) VALUES(
      p_vendor_id,p_request_id,p_shipping,p_fees,
      'Owner-confirmed current on-hand stock; no vendor order placed',
      p_actor_id,v_payload
    ) RETURNING * INTO v_po;
    INSERT INTO public.inventory_purchase_lines(
      purchase_order_id,offer_id,product_id,packs_ordered,
      units_per_pack_snapshot,pack_price_snapshot
    ) VALUES(v_po.id,v_offer,p_product_id,p_total,1,p_unit_cost);
  END IF;
  v_receipt:=public.core_inventory_receive_purchase(
    v_po.id,p_total-p_damaged,p_damaged,btrim(p_supplier_lot),
    p_expiry,p_request_id,p_actor_id
  );
  RETURN jsonb_build_object(
    'purchase_id',v_po.id,'receipt_id',v_receipt->>'receipt_id',
    'internal_lot',v_receipt->>'internal_lot',
    'available_units',p_total-p_damaged,'damaged_units',p_damaged,
    'already_received',coalesce((v_receipt->>'already_received')::boolean,false)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.core_inventory_register_current_stock(
  uuid,uuid,integer,integer,numeric,numeric,numeric,text,date,uuid,uuid
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.core_inventory_register_current_stock(
  uuid,uuid,integer,integer,numeric,numeric,numeric,text,date,uuid,uuid
) TO service_role;
