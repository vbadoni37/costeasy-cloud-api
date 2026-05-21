/**
 * Cost Sheets — Full Workflow Routes
 * Supports: Draft→Submit→Check→Approve→Offer BD→Offer Client→Accept→Lock
 */
const express = require('express');
const supabase = require('../supabase');
const { authenticate, checkLicense } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, checkLicense);

const STANDARD_OVERHEADS = [
  { key: 'testing_charges',    label: 'Testing Charges',    type: 'fixed',   default: 0 },
  { key: 'price_fluctuation',  label: 'Price Fluctuation',  type: 'pct_mat', default: 0 },
  { key: 'storage',            label: 'Storage',            type: 'pct_mat', default: 0 },
  { key: 'ccpc',               label: 'CCPC',               type: 'fixed',   default: 0 },
  { key: 'lab_testing',        label: 'Lab Testing',        type: 'pct_tot', default: 0 },
  { key: 'gst_compliance',     label: 'GST Compliance',     type: 'pct_tot', default: 0 },
  { key: 'finance_cost',       label: 'Finance Cost',       type: 'pct_tot', default: 0 },
  { key: 'other_cost',         label: 'Other Cost',         type: 'fixed',   default: 0 },
];

// ── Helper: calculate cost sheet totals ──────────────────────
function calculateCostSheet({ items, overheads, batch_size, yield_percent, sku_size, margin_pct }) {
  const output_qty  = (batch_size || 0) * ((yield_percent || 100) / 100);
  const mat_cost    = items.reduce((s, i) => s + (parseFloat(i.applied_price || i.base_price || 0) * parseFloat(i.quantity || 0)), 0);
  const rm_cost     = items.filter(i => i.category === 'RM').reduce((s, i) => s + (parseFloat(i.applied_price || i.base_price || 0) * parseFloat(i.quantity || 0)), 0);
  const pm_cost     = items.filter(i => i.category === 'PM').reduce((s, i) => s + (parseFloat(i.applied_price || i.base_price || 0) * parseFloat(i.quantity || 0)), 0);

  // Overheads
  let oh_fixed_pretot = 0;
  let oh_pct_mat = 0;
  let oh_pct_tot = 0;
  let margin_base_extra = 0;
  const oh_detail = [];

  (overheads || []).forEach(o => {
    let val = 0;
    if (o.type === 'fixed')   val = parseFloat(o.value || 0);
    if (o.type === 'pct_mat') val = mat_cost * (parseFloat(o.value || 0) / 100);
    if (o.type === 'pct_tot') {
      oh_pct_tot += parseFloat(o.value || 0);
      oh_detail.push({ ...o, computed: 0 }); // compute after
      return;
    }
    oh_fixed_pretot += val;
    if (o.in_margin) margin_base_extra += val;
    oh_detail.push({ ...o, computed: val });
  });

  // pct_tot is % of (mat + fixed overheads)
  const pre_pct_tot_base = mat_cost + oh_fixed_pretot;
  let oh_pct_tot_val = pre_pct_tot_base * (oh_pct_tot / 100);
  // Add pct_tot details
  (overheads || []).filter(o => o.type === 'pct_tot').forEach(o => {
    const val = pre_pct_tot_base * (parseFloat(o.value || 0) / 100);
    if (o.in_margin) margin_base_extra += val;
    oh_detail.find(d => d.key === o.key && d.computed === 0).computed = val;
  });

  const overhead_total = oh_fixed_pretot + oh_pct_tot_val;
  const total_cost     = mat_cost + overhead_total;
  const cost_per_unit  = output_qty > 0 ? total_cost / output_qty : 0;
  const cost_per_sku   = cost_per_unit * (sku_size || 1);

  // Margin base = mat_per_sku + selected overheads per sku
  const mat_per_sku     = output_qty > 0 ? mat_cost / output_qty * (sku_size || 1) : 0;
  const oh_extra_per_sku = output_qty > 0 ? margin_base_extra / output_qty * (sku_size || 1) : 0;
  const margin_base_sku  = mat_per_sku + oh_extra_per_sku;
  const selling_price_sku = margin_base_sku * (1 + (parseFloat(margin_pct) || 0) / 100);

  return {
    output_qty, rm_cost, pm_cost, mat_cost, overhead_total,
    total_cost, cost_per_unit, cost_per_sku,
    margin_base_sku, selling_price_sku,
    oh_detail,
  };
}

// ── GET /api/cost-sheets — list ───────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { client_name, bd_manager_id, status } = req.query;
    let q = supabase
      .from('cost_sheets')
      .select('*, products(name, product_code, client_name, bd_manager_id, batch_size, sku_size, sku_uom)')
      .eq('company_id', req.user.company_id)
      .order('created_at', { ascending: false });

    if (status)       q = q.eq('status', status);
    if (client_name)  q = q.eq('products.client_name', client_name);
    if (bd_manager_id) q = q.eq('products.bd_manager_id', bd_manager_id);

    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/cost-sheets/clients — unique client names ───────
router.get('/clients', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('client_name')
      .eq('company_id', req.user.company_id)
      .not('client_name', 'is', null);
    if (error) throw error;
    const clients = [...new Set(data.map(d => d.client_name).filter(Boolean))].sort();
    res.json(clients);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/cost-sheets/standard-overheads ──────────────────
router.get('/standard-overheads', (req, res) => {
  res.json(STANDARD_OVERHEADS);
});

// ── GET /api/cost-sheets/:id — full sheet ────────────────────
router.get('/:id', async (req, res) => {
  try {
    const [sheetRes, itemsRes, auditRes] = await Promise.all([
      supabase.from('cost_sheets').select('*, products(*,bd_manager:bd_managers(id,name,email))')
        .eq('id', req.params.id).eq('company_id', req.user.company_id).single(),
      supabase.from('cost_sheet_items').select('*')
        .eq('cost_sheet_id', req.params.id).order('category').order('material_name'),
      supabase.from('cost_sheet_audit').select('*')
        .eq('cost_sheet_id', req.params.id).order('created_at', { ascending: false }),
    ]);
    if (sheetRes.error) throw sheetRes.error;
    res.json({ ...sheetRes.data, items: itemsRes.data || [], audit: auditRes.data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/cost-sheets — create from product BOM ──────────
router.post('/', async (req, res) => {
  try {
    const { product_id, margin_pct = 5, notes, overheads } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id required' });

    const company_id = req.user.company_id;
    const user_name  = req.user.name || req.user.email;

    // Get product
    const { data: product, error: pErr } = await supabase
      .from('products').select('*').eq('id', product_id).single();
    if (pErr) throw pErr;

    // Get BOM items with latest prices
    const { data: bomItems } = await supabase
      .from('product_bom_items')
      .select('*, material:material_master(id, product_code, material_name, category, uom, is_temp_code)')
      .eq('product_id', product_id);

    // Check for CST codes
    const cstItems = (bomItems || []).filter(b => b.material?.is_temp_code);

    // Get latest prices for all materials in BOM
    const matIds = (bomItems || []).map(b => b.material_id).filter(Boolean);
    const { data: prices } = matIds.length > 0 ? await supabase
      .from('material_prices')
      .select('material_id, price, old_price, padding_percent, applied_price')
      .in('material_id', matIds)
      .eq('is_latest', true) : { data: [] };

    const priceMap = {};
    (prices || []).forEach(p => { priceMap[p.material_id] = p; });

    // Find old cost sheet for this product (client-offered priority → BD-offered → any)
    const { data: oldSheets } = await supabase
      .from('cost_sheets')
      .select('id, status')
      .eq('product_id', product_id)
      .in('status', ['offered_client', 'offered_bd', 'client_accepted', 'locked'])
      .order('created_at', { ascending: false })
      .limit(5);

    const oldClientSheet = oldSheets?.find(s => ['offered_client','client_accepted','locked'].includes(s.status));
    const oldBdSheet     = oldSheets?.find(s => s.status === 'offered_bd');
    const refSheetId     = oldClientSheet?.id || oldBdSheet?.id;

    let oldPriceMap = {};
    if (refSheetId) {
      const { data: oldItems } = await supabase
        .from('cost_sheet_items').select('material_id, applied_price, base_price')
        .eq('cost_sheet_id', refSheetId);
      (oldItems || []).forEach(i => { oldPriceMap[i.material_id] = i; });
    }

    // Build cost_sheet_items from BOM
    const defaultOverheads = overheads || STANDARD_OVERHEADS.map(o => ({
      ...o, value: 0, in_margin: false,
    }));

    const csItems = (bomItems || []).map(b => {
      const priceInfo   = priceMap[b.material_id] || {};
      const basePrice   = parseFloat(priceInfo.price || 0);
      const padding     = parseFloat(priceInfo.padding_percent || 0);
      const appliedPrice = basePrice * (1 + padding / 100);
      const oldRef       = oldPriceMap[b.material_id];
      return {
        material_id:       b.material_id,
        material_code:     b.material_code || b.material?.product_code,
        material_name:     b.material_name || b.material?.material_name,
        category:          b.category || b.material?.category || 'RM',
        uom:               b.uom || b.material?.uom || 'Kg',
        quantity:          b.quantity,
        padding_percent:   padding,
        base_price:        basePrice,
        applied_price:     appliedPrice,
        old_base_price:    oldRef?.base_price ?? basePrice,
        old_applied_price: oldRef?.applied_price ?? appliedPrice,
        total_current:     appliedPrice * b.quantity,
        total_old:         (oldRef?.applied_price ?? appliedPrice) * b.quantity,
        is_visible:        true,
        price_adjustment:  0,
      };
    });

    // Calculate totals
    const calc = calculateCostSheet({
      items: csItems,
      overheads: defaultOverheads,
      batch_size:     product.batch_size,
      yield_percent:  product.yield_percent,
      sku_size:       product.sku_size,
      margin_pct,
    });

    // Auto version number
    const { data: existingSheets } = await supabase
      .from('cost_sheets').select('id').eq('product_id', product_id);
    const versionNum = (existingSheets?.length || 0) + 1;
    const versionStr = `${new Date().toISOString().slice(0,10)}-v${versionNum}`;

    // Create cost sheet
    const { data: sheet, error: sErr } = await supabase
      .from('cost_sheets')
      .insert({
        product_id,
        company_id,
        version:            versionStr,
        status:             'draft',
        notes,
        batch_size:         product.batch_size,
        yield_percent:      product.yield_percent || 100,
        output_qty:         calc.output_qty,
        sku_size:           product.sku_size,
        sku_uom:            product.sku_uom,
        total_rm_cost:      calc.rm_cost,
        total_pm_cost:      calc.pm_cost,
        overhead_total:     calc.overhead_total,
        total_cost:         calc.total_cost,
        cost_per_unit:      calc.cost_per_unit,
        cost_per_sku:       calc.cost_per_sku,
        margin_pct:         parseFloat(margin_pct),
        selling_price:      calc.cost_per_unit * (1 + parseFloat(margin_pct) / 100),
        selling_price_per_sku: calc.selling_price_sku,
        final_price:        calc.selling_price_sku,
        final_price_per_sku: calc.selling_price_sku,
        margin_basis:       defaultOverheads.reduce((a, o) => ({ ...a, [o.key]: o.in_margin }), {}),
        created_by:         req.user.id,
        cost_ref_id:        refSheetId || null,
      })
      .select().single();
    if (sErr) throw sErr;

    // Insert cost sheet items
    const sheetItems = csItems.map((item, idx) => ({
      ...item, cost_sheet_id: sheet.id, sort_order: idx,
    }));
    if (sheetItems.length > 0) {
      await supabase.from('cost_sheet_items').insert(sheetItems);
    }

    // Log creation in audit
    await supabase.from('cost_sheet_audit').insert({
      cost_sheet_id: sheet.id, action: 'created',
      performed_by: req.user.id, performed_by_name: user_name,
      old_status: null, new_status: 'draft',
    });

    res.status(201).json({
      id: sheet.id,
      version: versionStr,
      cst_warning: cstItems.length > 0 ? `${cstItems.length} material(s) have temporary CST codes` : null,
      message: 'Cost sheet created',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/cost-sheets/:id — update items + overheads + recalc
router.put('/:id', async (req, res) => {
  try {
    const { items, overheads, margin_pct, notes } = req.body;
    const company_id = req.user.company_id;

    // Check not locked
    const { data: sheet } = await supabase.from('cost_sheets').select('status, is_locked, product_id')
      .eq('id', req.params.id).eq('company_id', company_id).single();
    if (sheet?.is_locked) return res.status(400).json({ error: 'Cost sheet is locked and cannot be edited' });
    if (['client_accepted','locked'].includes(sheet?.status))
      return res.status(400).json({ error: 'Cannot edit an accepted/locked cost sheet' });

    // Get product for batch/yield/sku
    const { data: product } = await supabase.from('products').select('*').eq('id', sheet.product_id).single();

    const calc = calculateCostSheet({
      items: items || [],
      overheads: overheads || [],
      batch_size:    product.batch_size,
      yield_percent: product.yield_percent,
      sku_size:      product.sku_size,
      margin_pct:    margin_pct || 5,
    });

    await supabase.from('cost_sheets').update({
      notes,
      total_rm_cost:      calc.rm_cost,
      total_pm_cost:      calc.pm_cost,
      overhead_total:     calc.overhead_total,
      total_cost:         calc.total_cost,
      cost_per_unit:      calc.cost_per_unit,
      cost_per_sku:       calc.cost_per_sku,
      margin_pct:         parseFloat(margin_pct || 5),
      selling_price_per_sku: calc.selling_price_sku,
      final_price_per_sku:   calc.selling_price_sku,
      margin_basis: (overheads || []).reduce((a, o) => ({ ...a, [o.key || o.label]: o.in_margin }), {}),
      last_edited_by: req.user.name || req.user.email,
      last_edited_at: new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    }).eq('id', req.params.id).eq('company_id', company_id);

    // Replace items
    if (items) {
      await supabase.from('cost_sheet_items').delete().eq('cost_sheet_id', req.params.id);
      if (items.length > 0) {
        await supabase.from('cost_sheet_items').insert(
          items.map((item, idx) => ({ ...item, cost_sheet_id: req.params.id, sort_order: idx }))
        );
      }
    }

    res.json({ message: 'Updated', totals: calc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/cost-sheets/:id/:action — workflow transitions ─
const TRANSITIONS = {
  submit:        { from: ['draft'],        to: 'submitted',      action: 'submitted' },
  check:         { from: ['submitted'],    to: 'checked',        action: 'checked' },
  approve:       { from: ['checked'],      to: 'approved',       action: 'approved' },
  'offer-bd':    { from: ['approved'],     to: 'offered_bd',     action: 'offered_bd' },
  'offer-client':{ from: ['offered_bd'],   to: 'offered_client', action: 'offered_client' },
  accept:        { from: ['offered_client'], to: 'client_accepted', action: 'client_accepted' },
  lock:          { from: ['client_accepted'], to: 'locked',      action: 'locked' },
  'revert-draft':{ from: ['submitted','checked'], to: 'draft',   action: 'revision_requested' },
};

router.post('/:id/:action', async (req, res) => {
  try {
    const { action } = req.params;
    const transition = TRANSITIONS[action];
    if (!transition) return res.status(400).json({ error: `Unknown action: ${action}` });

    const { remarks, bd_manager_id, client_price_per_sku } = req.body;
    const company_id = req.user.company_id;
    const user_name  = req.user.name || req.user.email;

    const { data: sheet, error: fetchErr } = await supabase
      .from('cost_sheets').select('*, products(*)')
      .eq('id', req.params.id).eq('company_id', company_id).single();
    if (fetchErr) throw fetchErr;

    if (!transition.from.includes(sheet.status))
      return res.status(400).json({ error: `Cannot perform '${action}' when status is '${sheet.status}'` });

    const updateData = {
      status:     transition.to,
      updated_at: new Date().toISOString(),
    };

    const now = new Date().toISOString();
    if (action === 'submit')         { updateData.submitted_at = now; }
    if (action === 'check')          { updateData.checked_by = req.user.id; updateData.checked_by_name = user_name; updateData.checked_at = now; updateData.check_remarks = remarks || ''; }
    if (action === 'approve')        { updateData.approved_by = req.user.id; updateData.approved_by_name = user_name; updateData.approved_at = now; updateData.approval_remarks = remarks || ''; }
    if (action === 'lock')           { updateData.is_locked = true; updateData.locked_reason = 'Client accepted'; }

    await supabase.from('cost_sheets').update(updateData)
      .eq('id', req.params.id).eq('company_id', company_id);

    // Create cost_offer record for BD/Client offers
    if (action === 'offer-bd' || action === 'offer-client') {
      const offerCount = await supabase.from('cost_offers').select('id', { count: 'exact' }).eq('company_id', company_id);
      const offerNum   = `CO-${new Date().getFullYear()}-${String((offerCount.count || 0) + 1).padStart(4, '0')}`;
      const validFrom  = new Date(); const validUntil = new Date();
      validUntil.setDate(validUntil.getDate() + 30);

      await supabase.from('cost_offers').insert({
        offer_number:          offerNum,
        cost_sheet_id:         sheet.id,
        product_id:            sheet.product_id,
        bd_manager_id:         bd_manager_id || sheet.products?.bd_manager_id,
        client_name:           sheet.products?.client_name,
        cost_price_per_unit:   sheet.cost_per_unit,
        cost_price_per_sku:    sheet.cost_per_sku,
        offer_price_per_sku:   sheet.selling_price_per_sku,
        selling_price_per_sku: sheet.selling_price_per_sku,
        margin_pct:            sheet.margin_pct,
        valid_from:            validFrom.toISOString().slice(0,10),
        valid_until:           validUntil.toISOString().slice(0,10),
        forwarded_to_bd:       action === 'offer-bd',
        sent_to_client:        action === 'offer-client',
        status:                'active',
        created_by:            req.user.id,
        company_id,
      });
    }

    // Audit log
    await supabase.from('cost_sheet_audit').insert({
      cost_sheet_id: req.params.id, action: transition.action,
      performed_by: req.user.id, performed_by_name: user_name,
      old_status: sheet.status, new_status: transition.to,
      remarks: remarks || '',
    });

    res.json({ message: `Cost sheet ${transition.to}`, status: transition.to });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/cost-sheets/:id ───────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { data: sheet } = await supabase.from('cost_sheets').select('status, is_locked')
      .eq('id', req.params.id).eq('company_id', req.user.company_id).single();
    if (sheet?.is_locked) return res.status(400).json({ error: 'Cannot delete a locked cost sheet' });
    await supabase.from('cost_sheet_items').delete().eq('cost_sheet_id', req.params.id);
    await supabase.from('cost_sheet_audit').delete().eq('cost_sheet_id', req.params.id);
    await supabase.from('cost_sheets').delete().eq('id', req.params.id).eq('company_id', req.user.company_id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/cost-sheets/summary/by-client ───────────────────
router.get('/summary/by-client', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cost_offers')
      .select('*, product:products(name,product_code,client_name,sku_uom), cost_sheet:cost_sheets(status,version,margin_pct,cost_per_sku)')
      .eq('company_id', req.user.company_id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Group by client
    const byClient = {};
    (data || []).forEach(offer => {
      const client = offer.client_name || 'Unknown';
      if (!byClient[client]) byClient[client] = { client_name: client, offers: [], total_value: 0, products: new Set() };
      byClient[client].offers.push(offer);
      byClient[client].total_value += parseFloat(offer.offer_price_per_sku || 0);
      byClient[client].products.add(offer.product_id);
    });

    const result = Object.values(byClient).map(c => ({
      ...c, products: c.products.size,
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/cost-sheets/summary/by-bd ───────────────────────
router.get('/summary/by-bd', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cost_offers')
      .select('*, bd_manager:bd_managers(id,name,email), product:products(name,client_name), cost_sheet:cost_sheets(status,version,margin_pct,cost_per_sku,selling_price_per_sku)')
      .eq('company_id', req.user.company_id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const byBd = {};
    (data || []).forEach(offer => {
      const bdId   = offer.bd_manager_id || 'unassigned';
      const bdName = offer.bd_manager?.name || 'Unassigned';
      if (!byBd[bdId]) byBd[bdId] = { bd_manager_id: bdId, bd_manager_name: bdName, offers: [], clients: new Set(), products: new Set() };
      byBd[bdId].offers.push(offer);
      byBd[bdId].clients.add(offer.client_name);
      byBd[bdId].products.add(offer.product_id);
    });

    const result = Object.values(byBd).map(b => ({
      ...b, clients: b.clients.size, products: b.products.size,
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
