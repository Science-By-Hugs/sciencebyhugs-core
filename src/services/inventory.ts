import { supabase } from './supabase'

export type InventoryVendor = { id:string; code:string; name:string; active:boolean; notes:string|null }
export type InventoryProduct = { id:string; product_code:string; name:string; price:number; product_type:string|null }
export type VendorOffer = {
  id:string; vendor_id:string; product_id:string; vendor_sku:string|null;
  units_per_pack:number; price_per_pack:number; estimated_inbound_shipping:number;
  lead_time_days:number|null; quote_date:string; active:boolean
}
export type InventoryPurchase = {
  id:string; po_number:string; vendor_id:string; status:string;
  shipping_actual:number; fees_actual:number; ordered_at:string; received_at:string|null;
  multi_line:boolean; allocation_method:'per_kit'|'by_cost'|'manual'|null
}
export type InventoryPurchaseLine = {
  id:string; purchase_order_id:string; offer_id:string; product_id:string;
  packs_ordered:number; units_per_pack_snapshot:number; pack_price_snapshot:number; expected_units:number;
  shipping_allocated:number; fees_allocated:number
}
export type InventoryLot = {
  id:string; receipt_id:string; vendor_id:string; product_id:string;
  internal_lot:string; supplier_lot:string; expiry_date:string|null;
  accepted_units:number; damaged_units:number; landed_unit_cost:number|null;
  cost_finalized:boolean; created_at:string
}
export type InventoryReceipt = {id:string;purchase_order_id:string;purchase_line_id:string|null;
  accepted_units:number;damaged_units:number;received_at:string}
export type InventorySettings = { product_id:string; supply_mode:string; reorder_point:number }
export type InventoryUnitCount = {product_id:string;state:'available'|'reserved'|'allocated'|'shipped'|'damaged'|'quarantined'|'returned'|'missing';count:number}
export type InventorySnapshot = {
  vendors:InventoryVendor[]; offers:VendorOffer[]; products:InventoryProduct[];
  orders:InventoryPurchase[]; lines:InventoryPurchaseLine[]; lots:InventoryLot[];
  settings:InventorySettings[]; receipts:InventoryReceipt[];
  unit_counts:InventoryUnitCount[]; counts_complete:boolean
}
export type InventoryUnitLabel = {
  unit_id:string; scan_token:string; state:string; ordinal:number; total_units:number;
  internal_lot:string; supplier_lot:string; product_code:string; product_name:string;
  expiry_date:string|null; qr_svg?:string
}
async function callInventory<T>(body:Record<string,unknown>):Promise<T> {
  const {data,error}=await supabase.functions.invoke('core-inventory-control',{body})
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Inventory operation failed')
  return data as T
}
export const listInventory=()=>callInventory<InventorySnapshot>({action:'list'})
export const addInventoryVendor=(name:string,code:string,notes:string)=>
  callInventory<{vendor:InventoryVendor}>({action:'add_vendor',name,code,notes})
export const saveVendorOffer=(offer:{
  vendorId:string; productId:string; unitsPerPack:number; pricePerPack:number;
  estimatedInboundShipping:number; vendorSku:string; leadTimeDays:number|string;
})=>callInventory<{offer:VendorOffer}>({action:'save_offer',...offer})
export const classifyInventoryProduct=(productId:string,supplyMode:'unreviewed'|'physical'|'vendor',reorderPoint:number)=>
  callInventory<{settings:InventorySettings}>({
    action:'classify_product',productId,supplyMode,reorderPoint,
  })
export const createInventoryPurchase=(offerId:string,packs:number,shipping:number,fees:number,requestId:string)=>
  callInventory<{purchase:{id:string;po_number:string;expected_units:number}}>({
    action:'create_purchase',offerId,packs,shipping,fees,requestId,
  })
export const receiveInventoryPurchase=(details:{
  orderId:string;accepted:number;damaged:number;supplierLot:string;expiryDate:string;requestId:string
})=>callInventory<{receipt:{lot_id:string;internal_lot:string;accepted_units:number;damaged_units:number;landed_unit_cost:number|null}}>({
  action:'receive_purchase',...details,
})
export const listInventoryLotLabels=(lotId:string,baseUrl:string)=>
  callInventory<{units:InventoryUnitLabel[];box_qr_svg?:string}>({action:'labels_for_lot',lotId,baseUrl})
export const lookupInventoryUnit=(token:string)=>
  callInventory<{units:InventoryUnitLabel[]}>({action:'lookup_unit',token})


export type MultiPurchaseLineInput = {
  offerId:string;packs:number;shipping?:number;fees?:number
}
export type AllocationMethod = 'per_kit'|'by_cost'|'manual'
export const createMultiInventoryPurchase=(details:{
  vendorId:string;lines:MultiPurchaseLineInput[];shipping:number;fees:number;
  allocationMethod:AllocationMethod;requestId:string
})=>callInventory<{purchase:{id:string;po_number:string;line_count:number;expected_units:number}}>({
  action:'create_multi_purchase',...details,
})
export const receiveMultiInventoryLine=(details:{
  lineId:string;accepted:number;damaged:number;
  supplierLot:string;expiryDate:string;requestId:string
})=>callInventory<{receipt:{lot_id:string;internal_lot:string;accepted_units:number;
  damaged_units:number;landed_unit_cost:number|null;cost_finalized:boolean}}>({
  action:'receive_multi_line',...details,
})


export type InventoryCountStatus = 'matched'|'pending'|'resolved'
export type InventoryStockAudit = {
  id:string;status:InventoryCountStatus;
  expected_available:number;expected_damaged:number;
  counted_available:number;counted_damaged:number;
  notes:string;created_at:string;resolved_at:string|null;resolved_unit_ids:string[]
}
export type InventoryAuditUnit = {
  id:string;ordinal:number;state:string
}
export type InventoryAuditLot = {
  lot:{id:string;internal_lot:string;product_id:string;supplier_lot:string;
    accepted_units:number;damaged_units:number};
  units:InventoryAuditUnit[];
  counts:{available:number;damaged:number;missing:number;reserved:number;quarantined:number};
  history:InventoryStockAudit[]
}
export type TrackedStockAction = 'damage'|'quarantine'|'restore_damaged'|'restore_quarantined'
export const adjustInventoryUnits=(details:{
  lotId:string;unitIds:string[];statusAction:TrackedStockAction;reason:string;requestId:string
})=>callInventory<{adjustment:{changed_units:number;action:TrackedStockAction;already_saved:boolean}}>({
  action:'adjust_units',...details,
})
export const loadLotAudit=(lotId:string)=>
  callInventory<InventoryAuditLot>({action:'audit_lot',lotId})
export const submitLotCount=(details:{
  lotId:string;countedAvailable:number;countedDamaged:number;notes:string;requestId:string
})=>callInventory<{audit:{
  count_id:string;status:InventoryCountStatus;
  expected_available:number;expected_damaged:number;
  counted_available:number;counted_damaged:number;already_saved:boolean
}}>({action:'submit_lot_count',...details})
export const resolveLotCount=(countId:string,missingUnitIds:string[])=>
  callInventory<{reconciliation:{
    count_id:string;status:'resolved';changed_units:number;already_resolved:boolean
  }}>({action:'resolve_lot_count',countId,missingUnitIds})


// Phase 5C. All values are computed by a private database function,
// surfaced only after the existing Core inventory API verifies owner JWT role.
// No inventory writes, refunds, reservations or recoveries occur on this call.
export type InventoryMonitoringAlert = {
  code:string
  severity:'critical'|'warning'
  order_id:string|null
  order_number:string|null
  first_seen:string
  title:string
  next_action:string
  expected_units:number
  actual_units:number
}
export type InventoryMonitoringSnapshot = {
  checked_at:string
  flags:{
    reservation_enabled:boolean;deduction_enabled:boolean
    recovery_enabled:boolean;activated_at:string|null
  }
  totals:{total:number;critical:number;warning:number}
  metrics:{
    held_units:number
    committed_units:number
    open_physical_lots_without_verified_count:number
    pending_reconciliation:number
  }
  alerts:InventoryMonitoringAlert[]
}
export const loadInventoryMonitoring=async()=>{
  const response=await callInventory<{monitor:InventoryMonitoringSnapshot}>({action:'monitor'})
  return response.monitor
}
