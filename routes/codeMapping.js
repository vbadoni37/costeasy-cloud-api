/**
 * Code Mapping Routes  (CST auto-code → ERP actual code)
 * GET  /api/code-mapping          - list all pending CST codes
 * POST /api/code-mapping          - map a CST code to ERP code
 * GET  /api/code-mapping/pending  - materials with is_temp_code=true
 */
const express = require('express');
const supabase = require('../supabase');
const { authenticate, checkLicense } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, checkLicense);

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── GET /api/code-mapping/pending ─────────────────────────────
// All material_master items that still have a CST temp code
router.get('/pending', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('material_master')
      .select('*')
      .eq('company_id', req.user.company_id)
      .eq('is_temp_code', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/code-mapping ─────────────────────────────────────
// Full history of all completed mappings
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('code_mapping')
      .select('*, material:material_master(id,product_code,material_name,category)')
      .eq('company_id', req.user.company_id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/code-mapping ────────────────────────────────────
// Map a CST code to a real ERP code — updates material_master.product_code
// Body: { material_id, erp_code, notes }
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { material_id, erp_code, notes } = req.body;
    if (!material_id || !erp_code)
      return res.status(400).json({ error: 'material_id and erp_code required' });

    const company_id = req.user.company_id;
    const user_name  = req.user.name || req.user.email;

    // Get current material
    const { data: mat, error: matErr } = await supabase
      .from('material_master')
      .select('*')
      .eq('id', material_id)
      .eq('company_id', company_id)
      .single();
    if (matErr || !mat) return res.status(404).json({ error: 'Material not found' });
    if (!mat.is_temp_code) return res.status(400).json({ error: 'This material does not have a temp CST code' });

    // Check ERP code not already used
    const { data: existing } = await supabase
      .from('material_master')
      .select('id')
      .eq('product_code', erp_code.trim())
      .eq('company_id', company_id)
      .maybeSingle();
    if (existing) return res.status(400).json({ error: `ERP code ${erp_code} already exists in Item Master` });

    // Log the mapping first
    await supabase.from('code_mapping').insert({
      cst_code:       mat.product_code,
      erp_code:       erp_code.trim(),
      material_id,
      material_name:  mat.material_name,
      mapped_by_name: user_name,
      notes:          notes || null,
      company_id,
    });

    // Update material_master: replace CST code with ERP code
    const { data: updated, error: updErr } = await supabase
      .from('material_master')
      .update({
        product_code:  erp_code.trim(),
        erp_code:      erp_code.trim(),
        is_temp_code:  false,
        updated_at:    new Date().toISOString(),
      })
      .eq('id', material_id)
      .eq('company_id', company_id)
      .select().single();
    if (updErr) throw updErr;

    // Also update bom_items that reference old CST code
    await supabase
      .from('bom_items')
      .update({ material_code: erp_code.trim() })
      .eq('material_id', material_id);

    res.json({
      message: `CST code ${mat.product_code} successfully mapped to ERP code ${erp_code}`,
      material: updated,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
