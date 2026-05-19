/**
 * Price Master Routes
 * GET    /api/price-master              - list latest prices for all materials
 * GET    /api/price-master/:materialId/history - price history for one material
 * PUT    /api/price-master/:materialId  - update price + padding (admin only)
 * POST   /api/price-master/upload       - bulk price upsert from xlsx/csv
 */
const express = require('express');
const supabase = require('../supabase');
const { authenticate, checkLicense } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, checkLicense);

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── GET /api/price-master ─────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { search, category, page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('material_prices')
      .select(`
        *,
        material:material_master(id, product_code, material_name, uom, category, sub_category)
      `, { count: 'exact' })
      .eq('company_id', req.user.company_id)
      .eq('is_latest', true)
      .order('created_at', { ascending: false });

    if (search) {
      query = query.or(
        `material_master.material_name.ilike.%${search}%,material_master.product_code.ilike.%${search}%`
      );
    }
    if (category) {
      query = query.eq('material_master.category', category);
    }

    query = query.range(offset, offset + parseInt(limit) - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ data, total: count, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/price-master/:materialId/history ─────────────────
router.get('/:materialId/history', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('price_change_log')
      .select('*')
      .eq('material_id', req.params.materialId)
      .eq('company_id', req.user.company_id)
      .order('change_date', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/price-master/:materialId ─────────────────────────
// Update price + padding for one material (logs old price automatically)
router.put('/:materialId', requireAdmin, async (req, res) => {
  try {
    const { price, padding_percent, change_reason } = req.body;
    if (price === undefined)
      return res.status(400).json({ error: 'price is required' });

    const company_id = req.user.company_id;
    const materialId = req.params.materialId;
    const user_name  = req.user.name || req.user.email;

    // 1. Get current latest price
    const { data: current } = await supabase
      .from('material_prices')
      .select('*')
      .eq('material_id', materialId)
      .eq('company_id', company_id)
      .eq('is_latest', true)
      .maybeSingle();

    const oldPrice   = current?.price ?? 0;
    const oldPadding = current?.padding_percent ?? 0;

    // 2. Mark old record as not latest
    if (current) {
      await supabase
        .from('material_prices')
        .update({ is_latest: false })
        .eq('id', current.id);
    }

    // 3. Get material info for log
    const { data: mat } = await supabase
      .from('material_master')
      .select('product_code, material_name')
      .eq('id', materialId)
      .single();

    // 4. Insert new latest price
    const newPadding = parseFloat(padding_percent) || oldPadding;
    const { data: newRec, error } = await supabase
      .from('material_prices')
      .insert({
        material_id:       materialId,
        price:             parseFloat(price),
        old_price:         oldPrice,
        padding_percent:   newPadding,
        is_latest:         true,
        date_of_update:    new Date().toISOString().split('T')[0],
        created_by_name:   user_name,
        company_id,
      })
      .select().single();
    if (error) throw error;

    // 5. Log the change
    await supabase.from('price_change_log').insert({
      material_id:           materialId,
      material_code:         mat?.product_code,
      material_name:         mat?.material_name,
      old_price:             oldPrice,
      new_price:             parseFloat(price),
      old_padding_percent:   oldPadding,
      new_padding_percent:   newPadding,
      changed_by_name:       user_name,
      change_reason:         change_reason || '',
      company_id,
    });

    res.json({ message: 'Price updated', data: newRec });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/price-master/upload (bulk upsert) ───────────────
// Expects: { rows: [{ product_code, material_name, uom, category, sub_category, price, old_price, date_of_update }] }
// Logic:
//   - For each row, find material by product_code (or create it in material_master)
//   - Archive current latest price, insert new latest price
//   - Log the change
router.post('/upload', requireAdmin, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array is required' });

    const company_id = req.user.company_id;
    const user_name  = req.user.name || req.user.email;
    const now        = new Date().toISOString();
    const today      = now.split('T')[0];

    const results = { updated: 0, created_item: 0, errors: [] };

    for (const row of rows) {
      try {
        if (!row.product_code) throw new Error('product_code is required');
        const code        = String(row.product_code).trim();
        const newPrice    = parseFloat(row.price) || 0;
        const oldPriceRaw = parseFloat(row.old_price) || null;
        const padding     = parseFloat(row.padding_percent) || 0;
        const dateUpdate  = row.date_of_update ? String(row.date_of_update).trim() : today;

        // Find or create material master entry
        let { data: mat } = await supabase
          .from('material_master')
          .select('id, product_code, material_name')
          .eq('product_code', code)
          .eq('company_id', company_id)
          .maybeSingle();

        if (!mat) {
          // Auto-create in item master when new item comes via price upload
          const { data: created, error: createErr } = await supabase
            .from('material_master')
            .insert({
              product_code:  code,
              material_name: row.material_name ? String(row.material_name).trim() : code,
              uom:           row.uom           ? String(row.uom).trim()           : 'Kg',
              category:      row.category      ? String(row.category).trim()      : 'RM',
              sub_category:  row.sub_category  ? String(row.sub_category).trim()  : null,
              initial_price: newPrice,
              company_id,
            })
            .select().single();
          if (createErr) throw createErr;
          mat = created;
          results.created_item++;
        }

        // Get current latest price
        const { data: current } = await supabase
          .from('material_prices')
          .select('id, price, padding_percent')
          .eq('material_id', mat.id)
          .eq('company_id', company_id)
          .eq('is_latest', true)
          .maybeSingle();

        const oldPrice   = oldPriceRaw !== null ? oldPriceRaw : (current?.price ?? 0);
        const oldPadding = current?.padding_percent ?? 0;

        // Mark old record as not latest
        if (current) {
          await supabase
            .from('material_prices')
            .update({ is_latest: false })
            .eq('id', current.id);
        }

        // Insert new latest price
        await supabase.from('material_prices').insert({
          material_id:       mat.id,
          price:             newPrice,
          old_price:         oldPrice,
          padding_percent:   padding,
          is_latest:         true,
          date_of_update:    dateUpdate,
          created_by_name:   user_name,
          company_id,
        });

        // Log only if price actually changed
        if (current && current.price !== newPrice) {
          await supabase.from('price_change_log').insert({
            material_id:         mat.id,
            material_code:       code,
            material_name:       mat.material_name,
            old_price:           oldPrice,
            new_price:           newPrice,
            old_padding_percent: oldPadding,
            new_padding_percent: padding,
            changed_by_name:     user_name,
            change_reason:       'Bulk upload',
            company_id,
          });
        }

        results.updated++;
      } catch (rowErr) {
        results.errors.push({ code: row.product_code, error: rowErr.message });
      }
    }

    res.json({
      message: `Upload complete: ${results.updated} updated, ${results.created_item} new items created`,
      ...results,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
