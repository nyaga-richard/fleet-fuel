// Human-friendly document numbers: REQ-2026-001234, TXN-2026-001235, ...
const SEQ = {
  request: { seq: 'request_no_seq', prefix: 'REQ' },
  transaction: { seq: 'txn_no_seq', prefix: 'TXN' },
  receipt: { seq: 'receipt_no_seq', prefix: 'RCP' },
  trip: { seq: 'trip_no_seq', prefix: 'TRP' },
  supplier_payment: { seq: 'supplier_payment_no_seq', prefix: 'PAY' },
  supplier_adjustment: { seq: 'supplier_adjustment_no_seq', prefix: 'ADJ' },
  supplier_purchase: { seq: 'supplier_purchase_no_seq', prefix: 'SPR' },
};

export async function nextDocNumber(client, kind) {
  const cfg = SEQ[kind];
  if (!cfg) throw new Error(`Unknown document kind: ${kind}`);
  const { rows } = await client.query(`SELECT nextval($1) AS n`, [cfg.seq]);
  const { rows: y } = await client.query(`SELECT to_char(now(), 'YYYY') AS year`);
  return `${cfg.prefix}-${y[0].year}-${String(rows[0].n).padStart(6, '0')}`;
}
