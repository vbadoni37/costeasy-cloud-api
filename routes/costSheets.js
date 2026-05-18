const express = require('express');
const supabase = require('../supabase');
const { authenticate, checkLicense } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, checkLicense);

// GET /api/cost-sheets — list all cost sheets
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('cost_sheets')
    .select('*, products(name)')
    .eq('company_id', req.user.company_id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/cost-sheets/:id — full cost sheet with BOM
router.get('/:id', async (req, res) => {
  const [sheetRes, bomRes, overheadRes] = await Promise.all([
    supabase.from('cost_sheets').select('*, products(*)').eq('id', req.params.id).eq('company_id', req.user.company_id).single(),
    supabase.from('bom_items').select('*, raw_materials(name, unit, rate_per_unit, gst_rate)').eq('cost_sheet_id', req.params.id),
    supabase.from('overhead_items').select('*').eq('cost_sheet_id', req.params.id),
  ]);
  if (sheetRes.error) return res.status(404).json({ error: 'Cost sheet not found' });
  res.json({ ...sheetRes.data, bom: bomRes.data || [], overhead: overheadRes.data || [] });
});

// POST /api/cost-sheets — create new cost sheet
router.post('/', async (req, res) => {
  const { product_id, version, notes, bom, overhead } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id required' });

  const { data: sheet, error: sheetErr } = await supabase
    .from('cost_sheets')
    .insert({ product_id, version: version || '1.0', notes, company_id: req.user.company_id, created_by: req.user.id })
    .select().single();
  if (sheetErr) return res.status(500).json({ error: sheetErr.message });

  if (bom && bom.length > 0) {
    const bomRows = bom.map(b => ({ ...b, cost_sheet_id: sheet.id }));
    await supabase.from('bom_items').insert(bomRows);
  }
  if (overhead && overhead.length > 0) {
    const ohRows = overhead.map(o => ({ ...o, cost_sheet_id: sheet.id }));
    await supabase.from('overhead_items').insert(ohRows);
  }

  res.status(201).json({ id: sheet.id, message: 'Cost sheet created' });
});

// PUT /api/cost-sheets/:id — update (replaces BOM + overhead)
router.put('/:id', async (req, res) => {
  const { notes, version, bom, overhead } = req.body;
  await supabase.from('cost_sheets').update({ notes, version, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('company_id', req.user.company_id);
  if (bom) {
    await supabase.from('bom_items').delete().eq('cost_sheet_id', req.params.id);
    if (bom.length > 0) await supabase.from('bom_items').insert(bom.map(b => ({ ...b, cost_sheet_id: req.params.id })));
  }
  if (overhead) {
    await supabase.from('overhead_items').delete().eq('cost_sheet_id', req.params.id);
    if (overhead.length > 0) await supabase.from('overhead_items').insert(overhead.map(o => ({ ...o, cost_sheet_id: req.params.id })));
  }
  res.json({ message: 'Updated' });
});

// DELETE /api/cost-sheets/:id
router.delete('/:id', async (req, res) => {
  await supabase.from('bom_items').delete().eq('cost_sheet_id', req.params.id);
  await supabase.from('overhead_items').delete().eq('cost_sheet_id', req.params.id);
  await supabase.from('cost_sheets').delete().eq('id', req.params.id).eq('company_id', req.user.company_id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
