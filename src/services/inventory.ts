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
  shipping_actual:number; fees_actual:number; ordered_at:string; received_at:string|null
}
export type InventoryPurchaseLine = {
  id:string; purchase_order_id:string; offer_id:string; product_id:string;
  packs_ordered:number; units_per_pack_snapshot:number; pack_price_snapshot:number; expected_units:number
}
export type InventoryLot = {
  id:string; receipt_id:string; vendor_id:string; product_id:string;
  internal_lot:string; supplier_lot:string; expiry_date:string|null;
  accepted_units:number; damaged_units:number; landed_unit_cost:number|null; created_at:string
}
export type InventorySettings = { product_id:string; supply_mode:string; reorder_point:number }
export type InventorySnapshot = {
  vendors:InventoryVendor[]; offers:VendorOffer[]; products:InventoryProduct[];
  orders:InventoryPurchase[]; lines:InventoryPurchaseLine[]; lots:InventoryLot[];
  settings:InventorySettings[]
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
  callInventory<{units:InventoryUnitLabel[]}>({action:'labels_for_lot',lotId,baseUrl})
export const lookupInventoryUnit=(token:string)=>
  callInventory<{units:InventoryUnitLabel[]}>({action:'lookup_unit',token})
