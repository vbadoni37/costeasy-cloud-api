/**
 * Product Master Routes
 * GET    /api/product-master         - list all products
 * POST   /api/product-master         - create single
 * PUT    /api/product-master/:id     - update single
 * DELETE /api/product-master/:id     - delete (admin)
 * POST   /api/product-master/upload  - bulk upsert from Excel
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

// ── GET /api/product-master ───────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { search, page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('products')
      .select('*, bd_manager:bd_managers(id,name,email)', { count: 'exact' })
      .eq('company_id', req.user.company_id)
      .order('name');

    if (search) {
      query = query.or(`name.ilike.%${search}%,product_code.ilike.%${search}%,client_name.ilike.%${search}%`);
    }
    query = query.range(offset, offset + parseInt(limit) - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/product-master/:id ───────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*, bd_manager:bd_managers(id,name,email)')
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/product-master ──────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  try {
    const {
      product_code, name, category, description,
      batch_size, batch_size_uom, yield_percent,
      sku_size, sku_uom, sku_size_uom, sku_type,
      client_name, bd_manager_id,
    } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { data, error } = await supabase
      .from('products')
      .insert({
        product_code, name, category, description,
        batch_size: parseFloat(batch_size) || 0,
        batch_size_uom: batch_size_uom || 'Kg',
        yield_percent: parseFloat(yield_percent) || 100,
        sku_size: parseFloat(sku_size) || 0,
        sku_uom, sku_size_uom, sku_type,
        client_name, bd_manager_id,
        company_id: req.user.company_id,
        created_by: req.user.id,
      })
      .select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/product-master/:id ───────────────────────────────
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const {
      product_code, name, category, description,
      batch_size, batch_size_uom, yield_percent,
      sku_size, sku_uom, sku_size_uom, sku_type,
      client_name, bd_manager_id,
    } = req.body;

    const { data, error } = await supabase
      .from('products')
      .update({
        product_code, name, category, description,
        batch_size: parseFloat(batch_size) || 0,
        batch_size_uom: batch_size_uom || 'Kg',
        yield_percent: parseFloat(yield_percent) || 100,
        sku_size: parseFloat(sku_size) || 0,
        sku_uom, sku_size_uom, sku_type,
        client_name, bd_manager_id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/product-master/:id ───────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id);
    if (error) throw error;
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/product-master/upload ──────────────────────────
// Expected cols: product_code, product_name, batch_size, batch_size_uom,
//                yield_percent, sku_size, sku_uom, client_name, bd_manager_name
router.post('/upload', requireAdmin, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array required' });

    const company_id = req.user.company_id;
    const now = new Date().toISOString();

    // Get all BD managers for lookup by name
    const { data: bdManagers } = await supabase
      .from('bd_managers')
      .select('id, name')
      .eq('company_id', company_id);
    const bdMap = {};
    (bdManagers || []).forEach(b => { bdMap[b.name.toLowerCase().trim()] = b.id; });

    const cleaned = rows.map((r, i) => {
      const name = String(r.product_name || r.name || '').trim();
      if (!name) throw new Error(`Row ${i + 2}: product_name is required`);
      const bdKey = String(r.bd_manager_name || '').toLowerCase().trim();
      return {
        product_code:   r.product_code   ? String(r.product_code).trim()   : null,
        name,
        category:       r.category       ? String(r.category).trim()       : null,
        description:    r.description    ? String(r.description).trim()    : null,
        batch_size:     parseFloat(r.batch_size)     || 0,
        batch_size_uom: r.batch_size_uom ? String(r.batch_size_uom).trim() : 'Kg',
        yield_percent:  parseFloat(r.yield_percent)  || 100,
        sku_size:       parseFloat(r.sku_size)        || 0,
        sku_uom:        r.sku_uom        ? String(r.sku_uom).trim()        : 'Kg',
        sku_size_uom:   r.sku_size_uom   ? String(r.sku_size_uom).trim()   : null,
        sku_type:       r.sku_type       ? String(r.sku_type).trim()       : null,
        client_name:    r.client_name    ? String(r.client_name).trim()    : null,
        bd_manager_id:  bdKey ? (bdMap[bdKey] || null) : null,
        company_id,
        created_by:     req.user.id,
        updated_at:     now,
      };
    });

    // Upsert on product_code + company_id if product_code exists, otherwise just insert
    const withCode    = cleaned.filter(r => r.product_code);
    const withoutCode = cleaned.filter(r => !r.product_code);

    const results = [];

    if (withCode.length > 0) {
      const { data, error } = await supabase
        .from('products')
        .upsert(withCode, { onConflict: 'product_code,company_id', ignoreDuplicates: false })
        .select();
      if (error) throw error;
      results.push(...data);
    }
    if (withoutCode.length > 0) {
      const { data, error } = await supabase
        .from('products')
        .insert(withoutCode)
        .select();
      if (error) throw error;
      results.push(...data);
    }

    res.json({ message: `${results.length} product(s) uploaded successfully`, inserted: results.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
