/**
 * Value Mapping Routes — Margin Waterfall Analysis
 * GET  /api/value-mapping              - list all products with offer status
 * GET  /api/value-mapping/:offerId     - full waterfall for one cost offer
 * POST /api/value-mapping/:offerId/actual-batch - upload actual batch cost
 */
const express = require('express');
const supabase = require('../supabase');
const { authenticate, checkLicense } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, checkLicense);

// ── Helper: build waterfall from data ────────────────────────
function buildWaterfall({ sheet, items, offer, actualBatch, product }) {
  const outputQty = parseFloat(sheet.output_qty || 0);
  const skuSize   = parseFloat(product?.sku_size || sheet.sku_size || 1);

  // ── Level 1: Cost Department ──────────────────────────────
  // Actual material cost WITHOUT padding (base_price × qty)
  const actualMatCostBatch = (items || []).reduce((s, i) =>
    s + (parseFloat(i.base_price || 0) * parseFloat(i.quantity || 0)), 0);
  // Applied material cost WITH padding (applied_price × qty)
  const appliedMatCostBatch = (items || []).reduce((s, i) =>
    s + (parseFloat(i.applied_price || 0) * parseFloat(i.quantity || 0)), 0);
  // Padding buffer per batch
  const paddingBatch = appliedMatCostBatch - actualMatCostBatch;

  const ohBatch          = parseFloat(sheet.overhead_total || 0);
  const totalActualBatch = actualMatCostBatch + ohBatch;

  // Per SKU (net of yield)
  const div = outputQty > 0 ? outputQty : 1;
  const actualMatPerSku   = (actualMatCostBatch / div) * skuSize;
  const appliedMatPerSku  = (appliedMatCostBatch / div) * skuSize;
  const paddingPerSku     = (paddingBatch / div) * skuSize;
  const ohPerSku          = (ohBatch / div) * skuSize;
  const totalActualPerSku = actualMatPerSku + ohPerSku;

  // RM / PM breakdown
  const rmActual = (items || []).filter(i => i.category === 'RM')
    .reduce((s, i) => s + parseFloat(i.base_price || 0) * parseFloat(i.quantity || 0), 0);
  const pmActual = (items || []).filter(i => i.category === 'PM')
    .reduce((s, i) => s + parseFloat(i.base_price || 0) * parseFloat(i.quantity || 0), 0);
  const rmPadding = (items || []).filter(i => i.category === 'RM')
    .reduce((s, i) => s + (parseFloat(i.applied_price || 0) - parseFloat(i.base_price || 0)) * parseFloat(i.quantity || 0), 0);

  const offeredToBdPerSku     = parseFloat(sheet.selling_price_per_sku || 0);
  const costDeptVisibleMargin = offeredToBdPerSku - appliedMatPerSku - ohPerSku;
  const costDeptRealMargin    = offeredToBdPerSku - totalActualPerSku;

  const level1 = {
    label:              'Cost Department',
    offered_price_sku:  offeredToBdPerSku,
    actual_rm_per_sku:  (rmActual / div) * skuSize,
    actual_pm_per_sku:  (pmActual / div) * skuSize,
    actual_mat_per_sku: actualMatPerSku,
    padding_per_sku:    paddingPerSku,
    rm_padding_per_sku: (rmPadding / div) * skuSize,
    oh_per_sku:         ohPerSku,
    total_actual_per_sku: totalActualPerSku,
    visible_margin_sku: costDeptVisibleMargin,
    real_margin_sku:    costDeptRealMargin,
    margin_pct:         offeredToBdPerSku > 0 ? (costDeptRealMargin / offeredToBdPerSku) * 100 : 0,
    complete:           true,
  };

  // ── Level 2: BD Department ────────────────────────────────
  const bdOfferedClientPerSku = offer?.sent_to_client
    ? parseFloat(offer.offer_price_per_sku || offeredToBdPerSku)
    : null;
  const bdMarginPerSku = bdOfferedClientPerSku !== null
    ? bdOfferedClientPerSku - offeredToBdPerSku : null;

  const level2 = {
    label:                 'BD Department',
    received_from_cost:    offeredToBdPerSku,
    offered_to_client_sku: bdOfferedClientPerSku,
    bd_margin_sku:         bdMarginPerSku,
    margin_pct:            bdOfferedClientPerSku && bdMarginPerSku !== null
      ? (bdMarginPerSku / bdOfferedClientPerSku) * 100 : null,
    complete:              offer?.sent_to_client || false,
  };

  // ── Level 3: CFO / PO Accepted ───────────────────────────
  const poPrice = offer?.status === 'accepted'
    ? parseFloat(offer.offer_price_per_sku || 0) : null;
  const cfoPlannedMargin = poPrice !== null ? poPrice - totalActualPerSku : null;
  const bdSecuredMargin  = (poPrice !== null && bdOfferedClientPerSku !== null)
    ? poPrice - bdOfferedClientPerSku : null;

  const level3 = {
    label:              'CFO / PO Accepted',
    po_price_sku:       poPrice,
    total_actual_per_sku: totalActualPerSku,
    planned_margin_sku: cfoPlannedMargin,
    bd_secured_margin:  bdSecuredMargin,
    combined_margin_sku: cfoPlannedMargin, // full company view
    margin_pct:         poPrice && cfoPlannedMargin !== null
      ? (cfoPlannedMargin / poPrice) * 100 : null,
    complete:           offer?.status === 'accepted',
  };

  // ── Level 4: Operations / Actual Batch ───────────────────
  let level4 = { label: 'Operations / Actual', complete: false };
  if (actualBatch) {
    const actualRmPerSku = parseFloat(actualBatch.actual_rm_cost || 0) / div * skuSize;
    const actualPmPerSku = parseFloat(actualBatch.actual_pm_cost || 0) / div * skuSize;
    const actualOhPerSku = parseFloat(actualBatch.actual_overhead || 0) / div * skuSize;
    const actualTotalPerSku = parseFloat(actualBatch.actual_cost_per_sku || 0)
      || ((parseFloat(actualBatch.actual_batch_total || 0) / div) * skuSize);

    const refPrice          = poPrice || bdOfferedClientPerSku || offeredToBdPerSku;
    const actualMarginPerSku = refPrice !== null ? refPrice - actualTotalPerSku : null;
    const procurementSaving  = actualMatPerSku - (actualRmPerSku + actualPmPerSku);
    const plantEfficiency    = ohPerSku - actualOhPerSku;

    level4 = {
      label:               'Operations / Actual',
      ref_price_sku:       refPrice,
      actual_rm_per_sku:   actualRmPerSku,
      actual_pm_per_sku:   actualPmPerSku,
      actual_oh_per_sku:   actualOhPerSku,
      actual_total_per_sku: actualTotalPerSku,
      actual_margin_sku:   actualMarginPerSku,
      procurement_saving:  procurementSaving,
      plant_efficiency:    plantEfficiency,
      margin_pct:          refPrice && actualMarginPerSku !== null
        ? (actualMarginPerSku / refPrice) * 100 : null,
      batch_number:        actualBatch.batch_number,
      batch_date:          actualBatch.batch_date,
      complete:            true,
    };
  }

  return { level1, level2, level3, level4, meta: { output_qty: outputQty, sku_size: skuSize, product_name: product?.name, batch_size: product?.batch_size } };
}

// ── GET /api/value-mapping — list products with offers ───────
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cost_offers')
      .select(`
        id, offer_number, client_name, status, created_at,
        offer_price_per_sku, cost_price_per_sku, margin_pct,
        forwarded_to_bd, sent_to_client,
        product:products(id, name, product_code, client_name, sku_size, sku_uom, batch_size),
        cost_sheet:cost_sheets(id, version, status, selling_price_per_sku, cost_per_sku, margin_pct)
      `)
      .eq('company_id', req.user.company_id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Enrich with actual batch availability
    const offerIds = (data || []).map(d => d.id);
    const { data: batches } = await supabase
      .from('actual_batch_cost')
      .select('cost_offer_id')
      .in('cost_offer_id', offerIds);

    const batchSet = new Set((batches || []).map(b => b.cost_offer_id));

    const enriched = (data || []).map(o => ({
      ...o,
      has_actual_batch: batchSet.has(o.id),
      steps_complete: [
        true,                          // cost dept always complete
        o.forwarded_to_bd,             // BD received
        o.sent_to_client,              // sent to client
        o.status === 'accepted',       // PO accepted
        batchSet.has(o.id),            // actual batch uploaded
      ],
    }));

    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/value-mapping/:offerId — full waterfall ─────────
router.get('/:offerId', async (req, res) => {
  try {
    const company_id = req.user.company_id;

    // Get offer + cost sheet + product
    const { data: offer, error: oErr } = await supabase
      .from('cost_offers')
      .select('*, product:products(*), cost_sheet:cost_sheets(*)')
      .eq('id', req.params.offerId)
      .eq('company_id', company_id)
      .single();
    if (oErr) throw oErr;

    // Get cost sheet items (base_price vs applied_price = padding info)
    const { data: items } = await supabase
      .from('cost_sheet_items')
      .select('*')
      .eq('cost_sheet_id', offer.cost_sheet_id);

    // Get actual batch cost if available
    const { data: batches } = await supabase
      .from('actual_batch_cost')
      .select('*')
      .eq('cost_offer_id', req.params.offerId)
      .order('created_at', { ascending: false })
      .limit(1);

    const actualBatch = batches?.[0] || null;
    const waterfall   = buildWaterfall({
      sheet:  offer.cost_sheet,
      items:  items || [],
      offer,
      actualBatch,
      product: offer.product,
    });

    res.json({ offer, waterfall });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/value-mapping/:offerId/actual-batch ────────────
// Body: { rows: [{ actual_rm_cost, actual_pm_cost, actual_overhead, actual_batch_total, actual_cost_per_sku, batch_number, batch_date, notes }] }
router.post('/:offerId/actual-batch', async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array required' });

    const company_id = req.user.company_id;
    const user_name  = req.user.name || req.user.email;

    const { data: offer } = await supabase
      .from('cost_offers')
      .select('product_id')
      .eq('id', req.params.offerId)
      .eq('company_id', company_id)
      .single();
    if (!offer) return res.status(404).json({ error: 'Offer not found' });

    const toInsert = rows.map(r => ({
      product_id:          offer.product_id,
      cost_offer_id:       req.params.offerId,
      batch_number:        r.batch_number || null,
      batch_date:          r.batch_date   || new Date().toISOString().slice(0,10),
      actual_rm_cost:      parseFloat(r.actual_rm_cost)      || 0,
      actual_pm_cost:      parseFloat(r.actual_pm_cost)      || 0,
      actual_overhead:     parseFloat(r.actual_overhead)     || 0,
      actual_batch_total:  parseFloat(r.actual_batch_total)  || 0,
      actual_cost_per_sku: parseFloat(r.actual_cost_per_sku) || 0,
      notes:               r.notes || null,
      uploaded_by_name:    user_name,
      company_id,
    }));

    const { data, error } = await supabase
      .from('actual_batch_cost')
      .insert(toInsert)
      .select();
    if (error) throw error;

    res.json({ message: `${data.length} batch record(s) uploaded`, data });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
