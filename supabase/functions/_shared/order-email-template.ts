// Neutral transactional messages only; never include catalog contents or marketing.
export type OrderEmailEvent = {
  event_type: 'received' | 'status_changed' | 'delivery_date_changed'
  order_number: string | null
  order_status: string | null
  delivery_date: string | null
}

export function escapeEmailHtml(value: unknown): string {
  return String(value ?? '').replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export function orderStatusText(status: string | null) {
  switch ((status || '').trim().toLowerCase().replace(/[\s-]+/g, '_')) {
    case 'ordered': case 'placed': case 'submitted': case 'received':
      return 'received'
    case 'confirmed': case 'accepted':
      return 'confirmed'
    case 'processing': case 'preparing': case 'in_progress':
      return 'being prepared'
    case 'ready': case 'ready_for_delivery': case 'ready_for_dropoff':
      return 'ready for local delivery'
    case 'shipped': case 'out_for_delivery':
      return 'out for local delivery'
    case 'delivered': case 'completed':
      return 'delivered'
    case 'delayed': case 'on_hold':
      return 'delayed'
    case 'cancelled': case 'canceled':
      return 'cancelled'
    default:
      return 'updated'
  }
}

function deliveryDateText(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(value + 'T12:00:00Z')
  if (!Number.isFinite(date.getTime())) return null
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
}

export function composeOrderEmail(event: OrderEmailEvent, displayName: string) {
  const reference = String(event.order_number || '').replace(/[^A-Za-z0-9#_\- ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'your order'
  const referenceText = reference === 'your order' ? 'Your order' : 'Order ' + reference
  const statusText = orderStatusText(event.order_status)
  let title = referenceText + ' update'
  let summary = 'There is an update on your order. Sign in to Nexus to review the details.'

  if (event.event_type === 'received') {
    title = referenceText + ' received'
    summary = 'We received your order. You can follow its progress in Nexus.'
  } else if (event.event_type === 'status_changed') {
    title = referenceText + ': ' + statusText
    summary = statusText === 'updated'
      ? 'The status of your order has changed. Sign in to Nexus for details.'
      : 'Your order is now ' + statusText + '. Sign in to Nexus to review the details.'
  } else if (event.event_type === 'delivery_date_changed') {
    title = referenceText + ': delivery estimate updated'
    const date = deliveryDateText(event.delivery_date)
    summary = date
      ? 'The estimated local delivery date for your order is now ' + date + '. This is an estimate, not a guaranteed delivery time.'
      : 'The delivery estimate has changed. Please open Nexus for the latest details.'
  }

  const name = String(displayName || '').trim().slice(0, 100) || 'there'
  const subject = title.slice(0, 160)
  const htmlContent = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:28px 12px;background:#f2f3f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#242930">
<table role="presentation" style="max-width:560px;width:100%;margin:auto;border-spacing:0;background:white;border-radius:16px;overflow:hidden">
<tr><td style="padding:30px 28px 12px;background:#242930;color:#fff"><p style="letter-spacing:.18em;font-size:11px;margin:0">SCIENCE BY HUGS</p><h1 style="font-size:24px;line-height:1.3;margin:16px 0 8px">Nexus Order Update</h1></td></tr>
<tr><td style="padding:26px 28px"><p style="font-size:16px;margin-top:0">Hi ${escapeEmailHtml(name)},</p>
<p style="font-size:15px;line-height:1.6">${escapeEmailHtml(summary)}</p>
<a href="https://nexus.sciencebyhugs.com" style="background:#303741;color:white;display:inline-block;padding:12px 19px;border-radius:10px;text-decoration:none;font-weight:600">Open Nexus</a>
<p style="color:#646c75;font-size:12px;line-height:1.5;margin-top:30px">You received this optional transactional update because you enabled order emails in your Science By Hugs account. You can turn them off in Nexus → Account → Notifications. This is not a promotional message.</p></td></tr>
</table></body></html>`
  return { subject, htmlContent }
}
