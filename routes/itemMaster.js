/**
 * Item Master Routes
 * GET    /api/item-master          - list all (paginated + search)
 * POST   /api/item-master          - create single
 * PUT    /api/item-master/:id      - update single
 * DELETE /api/item-master/:id      - delete (admin only)
 * POST   /api/item-master/upload   - bulk upsert from xlsx/csv parse
 */
const express = require('express');
const supabase = require('../supabase');
const { authenticate, checkLicense } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, checkLicense);

// ── Helper: require admin role ────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── GET /api/item-master ──────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { search, category, page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('material_master')
      .select(`
        *,
        latest_price:material_prices(price, old_price, padding_percent, applied_price, date_of_update)
      `, { count: 'exact' })
      .eq('company_id', req.user.company_id)
      .eq('material_prices.is_latest', true)
      .order('material_name');

    if (search) {
      query = query.or(
        `material_name.ilike.%${search}%,product_code.ilike.%${search}%,sub_category.ilike.%${search}%`
      );
    }
    if (category) {
      query = query.eq('category', category);
    }

    query = query.range(offset, offset + parseInt(limit) - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    // Flatten the latest_price join
    const items = data.map(m => ({
      ...m,
      price:           m.latest_price?.[0]?.price ?? m.initial_price ?? 0,
      old_price:       m.latest_price?.[0]?.old_price ?? 0,
      padding_percent: m.latest_price?.[0]?.padding_percent ?? 0,
      applied_price:   m.latest_price?.[0]?.applied_price ?? m.initial_price ?? 0,
      date_of_update:  m.latest_price?.[0]?.date_of_update ?? null,
      latest_price:    undefined,
    }));

    res.json({ data: items, total: count, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/item-master ─────────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { product_code, material_name, uom, category, sub_category, initial_price } = req.body;
    if (!product_code || !material_name || !uom)
      return res.status(400).json({ error: 'product_code, material_name, uom are required' });

    const company_id = req.user.company_id;
    const price = parseFloat(initial_price) || 0;

    const { data, error } = await supabase
      .from('material_master')
      .insert({ product_code, material_name, uom, category, sub_category,
                initial_price: price, company_id })
      .select().single();
    if (error) throw error;

    // Auto-create initial price record in Price Master
    if (price > 0) {
      const today = new Date().toISOString().split('T')[0];
      await supabase.from('material_prices').insert({
        material_id: data.id, price, old_price: 0,
        padding_percent: 0, is_latest: true,
        date_of_update: today, created_by_name: req.user.name || req.user.email,
        company_id,
      });
      await supabase.from('price_change_log').insert({
        material_id: data.id, material_code: product_code,
        material_name, old_price: 0, new_price: price,
        old_padding_percent: 0, new_padding_percent: 0,
        changed_by_name: req.user.name || req.user.email,
        change_reason: 'Initial price from Item Master', company_id,
      });
    }

    res.status(201).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/item-master/:id ──────────────────────────────────
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { material_name, uom, category, sub_category, initial_price } = req.body;
    const { data, error } = await supabase
      .from('material_master')
      .update({ material_name, uom, category, sub_category, initial_price,
                updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id)
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/item-master/:id ───────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('material_master')
      .delete()
      .eq('id', req.params.id)
      .eq('company_id', req.user.company_id);
    if (error) throw error;
    res.json({ message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/item-master/upload (bulk upsert) ────────────────
// Expects JSON body: { rows: [ { product_code, material_name, uom, category, sub_category, initial_price } ] }
router.post('/upload', requireAdmin, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array is required' });

    const company_id = req.user.company_id;
    const now = new Date().toISOString();

    // Validate and clean rows
    const cleaned = rows.map((r, i) => {
      if (!r.product_code || !r.material_name || !r.uom)
        throw new Error(`Row ${i + 2}: product_code, material_name, uom are required`);
      return {
        product_code:  String(r.product_code).trim(),
        material_name: String(r.material_name).trim(),
        uom:           String(r.uom).trim(),
        category:      r.category ? String(r.category).trim() : 'RM',
        sub_category:  r.sub_category ? String(r.sub_category).trim() : null,
        initial_price: parseFloat(r.initial_price) || 0,
        company_id,
        updated_at: now,
      };
    });

    // Deduplicate by product_code — keep last occurrence if Excel has duplicates
    const deduped = Object.values(
      cleaned.reduce((map, row) => { map[row.product_code] = row; return map; }, {})
    );

    // Upsert on (product_code, company_id)
    const { data, error } = await supabase
      .from('material_master')
      .upsert(deduped, { onConflict: 'product_code,company_id', ignoreDuplicates: false })
      .select();
    if (error) throw error;

    // Auto-create price records for items with initial_price > 0
    const today = new Date().toISOString().split('T')[0];
    const user_name = req.user.name || req.user.email;
    let pricesCreated = 0;

    for (const item of data) {
      if (item.initial_price > 0) {
        // Check if price record already exists
        const { data: existingPrice } = await supabase
          .from('material_prices')
          .select('id')
          .eq('material_id', item.id)
          .eq('company_id', company_id)
          .eq('is_latest', true)
          .maybeSingle();

        if (!existingPrice) {
          // No price record yet — create initial one
          await supabase.from('material_prices').insert({
            material_id: item.id, price: item.initial_price, old_price: 0,
            padding_percent: 0, is_latest: true,
            date_of_update: today, created_by_name: user_name, company_id,
          });
          await supabase.from('price_change_log').insert({
            material_id: item.id, material_code: item.product_code,
            material_name: item.material_name,
            old_price: 0, new_price: item.initial_price,
            old_padding_percent: 0, new_padding_percent: 0,
            changed_by_name: user_name,
            change_reason: 'Initial price from Item Master upload', company_id,
          });
          pricesCreated++;
        }
      }
    }

    res.json({
      message: `Successfully uploaded ${data.length} item(s), ${pricesCreated} initial price(s) created in Price Master`,
      inserted: data.length,
      pricesCreated,
      rows: data,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
