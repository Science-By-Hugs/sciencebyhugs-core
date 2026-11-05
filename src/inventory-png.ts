import type { InventoryUnitLabel } from './services/inventory'

// 1.90 × 0.90 inches at 300 DPI; intentionally inset from 2 × 1 inch stock.
export const LABEL_WIDTH_PX = 570
export const LABEL_HEIGHT_PX = 270
export const LABEL_DPI = 300

export function inventoryPngFilename(unit:InventoryUnitLabel) {
  const lot=unit.internal_lot.replace(/[^A-Za-z0-9_-]/g,'_')
  return lot+'_UNIT-'+String(unit.ordinal).padStart(2,'0')+'.png'
}

function writeBigEndian(bytes:Uint8Array,index:number,value:number) {
  bytes[index]=(value>>>24)&255
  bytes[index+1]=(value>>>16)&255
  bytes[index+2]=(value>>>8)&255
  bytes[index+3]=value&255
}

function crc32(bytes:Uint8Array) {
  let crc=0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0)
  }
  return (crc^0xffffffff)>>>0
}

// The Canvas PNG defaults to 96 DPI. Embed 300 DPI so thermal-label
// software that reads PNG resolution can honor the intended physical size.
// Drop any existing pHYs chunk before inserting our own after IHDR.
export async function setPngResolution(png:Blob,dpi:number):Promise<Blob> {
  const original=new Uint8Array(await png.arrayBuffer())
  const signature=[137,80,78,71,13,10,26,10]
  if (!signature.every((byte,index)=>original[index]===byte)) throw new Error('Not a PNG')
  const view=new DataView(original.buffer,original.byteOffset,original.byteLength)
  const chunks:Uint8Array[]=[]
  let position=8, foundHeader=false
  while (position<original.length) {
    if (position+12>original.length) throw new Error('Invalid PNG chunk')
    const length=view.getUint32(position)
    const end=position+12+length
    if (end>original.length) throw new Error('Invalid PNG chunk length')
    const kind=String.fromCharCode(...original.subarray(position+4,position+8))
    if (kind!=='pHYs') chunks.push(original.subarray(position,end))
    if (kind==='IHDR') {
      foundHeader=true
      const chunk=new Uint8Array(21)
      writeBigEndian(chunk,0,9)
      chunk.set([112,72,89,115],4) // pHYs
      const pixelsPerMeter=Math.round(dpi/0.0254)
      writeBigEndian(chunk,8,pixelsPerMeter)
      writeBigEndian(chunk,12,pixelsPerMeter)
      chunk[16]=1 // metres
      writeBigEndian(chunk,17,crc32(chunk.subarray(4,17)))
      chunks.push(chunk)
    }
    position=end
    if (kind==='IEND') break
  }
  if (!foundHeader || position!==original.length) throw new Error('Invalid PNG file')
  const size=8+chunks.reduce((sum,chunk)=>sum+chunk.length,0)
  const output=new Uint8Array(size)
  output.set(signature,0)
  let offset=8
  for (const chunk of chunks) { output.set(chunk,offset);offset+=chunk.length }
  return new Blob([output.buffer as ArrayBuffer],{type:'image/png'})
}

export async function inventoryUnitPng(unit:InventoryUnitLabel):Promise<Blob> {
  if (!unit.qr_svg || !unit.scan_token) throw new Error('This unit has no QR label')
  const canvas=document.createElement('canvas')
  canvas.width=LABEL_WIDTH_PX
  canvas.height=LABEL_HEIGHT_PX
  const ctx=canvas.getContext('2d')
  if (!ctx) throw new Error('PNG export is not supported by this browser')
  ctx.fillStyle='#ffffff'
  ctx.fillRect(0,0,canvas.width,canvas.height)

  const source=URL.createObjectURL(new Blob([unit.qr_svg],{type:'image/svg+xml'}))
  try {
    const qr=new Image()
    qr.src=source
    await qr.decode()
    ctx.imageSmoothingEnabled=false
    ctx.drawImage(qr,18,18,234,234)
  } finally { URL.revokeObjectURL(source) }

  ctx.fillStyle='#000000'
  ctx.textBaseline='top'
  ctx.font='bold 19px Arial, sans-serif'
  ctx.fillText('SCIENCE BY HUGS',260,40,290)
  ctx.font='bold 26px Arial, sans-serif'
  ctx.fillText(unit.product_code||'PRODUCT',260,82,292)
  ctx.font='20px Arial, sans-serif'
  ctx.fillText(unit.internal_lot,260,130,296)
  ctx.fillRect(260,173,285,2)
  ctx.font='bold 22px Arial, sans-serif'
  ctx.fillText('UNIT '+String(unit.ordinal).padStart(2,'0')+'/'+String(unit.total_units).padStart(2,'0'),260,194,280)

  const png=await new Promise<Blob>((resolve,reject)=>{
    canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not create PNG')),'image/png')
  })
  return setPngResolution(png,LABEL_DPI)
}
