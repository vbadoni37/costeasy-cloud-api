/**
 * BOM Routes
 * GET  /api/bom/:productId           - get current BOM for a product
 * POST /api/bom/upload               - upload BOM from parsed Excel rows
 * PUT  /api/bom/:productId/freeze    - freeze/unfreeze BOM
 * POST /api/bom/:productId/item      - add single item to BOM
 * PUT  /api/bom/:productId/item/:id  - update single BOM item
 * DELETE /api/bom/:productId/item/:id - remove one item from BOM
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

// ── UOM Normalisation ─────────────────────────────────────────
const UOM_EXCEPTIONS = ['caps', 'capsule', 'capsules', 'nos', 'no.', 'pcs', 'piece',
  'pieces', 'tab', 'tabs', 'tablet', 'tablets', 'sachet', 'sachets', 'strip', 'strips', 'unit', 'units'];

function normalizeUOM(rawUom, rawQty) {
  const u   = (rawUom  || '').toLowerCase().trim();
  const qty = parseFloat(rawQty) || 0;

  // Exceptions — keep as-is
  if (UOM_EXCEPTIONS.some(ex => u === ex || u.startsWith(ex))) {
    return { qty, uom: rawUom.trim() };
  }

  // Weight → Kg
  if (['g', 'gm', 'gms', 'gram', 'grams'].includes(u))
    return { qty: qty / 1000, uom: 'Kg' };
  if (['mg', 'milligram', 'milligrams'].includes(u))
    return { qty: qty / 1000000, uom: 'Kg' };
  if (['kg', 'kgs', 'kilogram', 'kilograms'].includes(u))
    return { qty, uom: 'Kg' };

  // Volume → Ltr
  if (['ml', 'milliliter', 'millilitre', 'milliliters', 'millilitres'].includes(u))
    return { qty: qty / 1000, uom: 'Ltr' };
  if (['l', 'ltr', 'liter', 'litre', 'liters', 'litres'].includes(u))
    return { qty, uom: 'Ltr' };

  // Unknown — keep as-is
  return { qty, uom: rawUom.trim() };
}

// ── Auto-generate CST code ────────────────────────────────────
async function generateCSTCode(company_id) {
  // Find highest existing CST code for this company
  const { data } = await supabase
    .from('material_master')
    .select('product_code')
    .eq('company_id', company_id)
    .ilike('product_code', 'CST%')
    .order('product_code', { ascending: false })
    .limit(1);

  let nextNum = 1;
  if (data && data.length > 0) {
    const last = data[0].product_code; // e.g. CST00042
    const num  = parseInt(last.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(num)) nextNum = num + 1;
  }
  return `CST${String(nextNum).padStart(5, '0')}`;
}

// ── GET /api/bom/:productId ───────────────────────────────────
router.get('/:productId', async (req, res) => {
  try {
    const { data: product, error: pErr } = await supabase
      .from('products')
      .select('id, name, product_code, batch_size, batch_size_uom, yield_percent, sku_size, sku_uom, is_bom_frozen, bom_frozen_at, bom_frozen_by')
      .eq('id', req.params.productId)
      .eq('company_id', req.user.company_id)
      .single();
    if (pErr) throw pErr;

    const { data: items, error: iErr } = await supabase
      .from('bom_items')
      .select('*, material:material_master(id, product_code, material_name, category, sub_category, is_temp_code, erp_code)')
      .eq('product_id', req.params.productId)
      .order('category')
      .order('material_name');
    if (iErr) throw iErr;

    // Flag if any items have temp CST codes
    const hasCSTCodes = items.some(i => i.material?.is_temp_code);

    res.json({ product, items, hasCSTCodes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/bom/upload ──────────────────────────────────────
// Expects: { product_id, rows: [{ material_code, material_name, quantity, uom, category, sub_category }] }
router.post('/upload', requireAdmin, async (req, res) => {
  try {
    const { product_id, rows } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id required' });
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array required' });

    const company_id  = req.user.company_id;
    const user_name   = req.user.name || req.user.email;
    const newItems    = [];
    const cstCreated  = [];
    const uomConverted = [];

    for (const row of rows) {
      // 1. Normalise UOM
      const rawQty = parseFloat(row.quantity) || 0;
      const rawUom = String(row.uom || 'Kg');
      const { qty, uom } = normalizeUOM(rawUom, rawQty);
      if (uom !== rawUom.trim()) {
        uomConverted.push({ code: row.material_code, from: `${rawQty} ${rawUom}`, to: `${qty} ${uom}` });
      }

      // 2. Find or create material in material_master
      let material = null;
      if (row.material_code && row.material_code.toString().trim()) {
        const code = String(row.material_code).trim();
        const { data } = await supabase
          .from('material_master')
          .select('*')
          .eq('product_code', code)
          .eq('company_id', company_id)
          .maybeSingle();
        material = data;
      }

      if (!material) {
        // Auto-create with CST code
        const cstCode = await generateCSTCode(company_id);
        const { data: created, error } = await supabase
          .from('material_master')
          .insert({
            product_code:  cstCode,
            material_name: String(row.material_name || 'Unknown Material').trim(),
            uom,
            category:      row.category    ? String(row.category).trim()    : 'RM',
            sub_category:  row.sub_category? String(row.sub_category).trim(): null,
            initial_price: 0,
            is_temp_code:  true,
            company_id,
          })
          .select().single();
        if (error) throw error;
        material = created;
        cstCreated.push({ cstCode, material_name: material.material_name });
      }

      newItems.push({
        product_id,
        material_id:    material.id,
        material_code:  material.product_code,
        material_name:  material.material_name,
        quantity:       qty,
        uom,
        category:       row.category     ? String(row.category).trim()     : (material.category || 'RM'),
        sub_category:   row.sub_category ? String(row.sub_category).trim() : null,
        is_frozen:      false,
      });
    }

    // 3. Replace existing BOM (delete all then insert)
    await supabase.from('bom_items').delete().eq('product_id', product_id);

    const { data: inserted, error: insErr } = await supabase
      .from('bom_items')
      .insert(newItems)
      .select();
    if (insErr) throw insErr;

    // 4. Unfreeze product BOM since it changed
    await supabase
      .from('products')
      .update({ is_bom_frozen: false, bom_frozen_at: null, bom_frozen_by: null })
      .eq('id', product_id);

    res.json({
      message: `BOM uploaded: ${inserted.length} item(s)`,
      items: inserted.length,
      cst_codes_created: cstCreated,
      uom_conversions: uomConverted,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── POST /api/bom/bulk-upload ─────────────────────────────────
// Handles the real Excel format with columns:
//   Product code, Product Name, Batch size, Yield%, Pack/SKU, Client,
//   Material Code, Material Name, Type(RM/PM), QTY, UCM/UOM
router.post('/bulk-upload', requireAdmin, async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array required' });

    const company_id = req.user.company_id;
    const user_name  = req.user.name || req.user.email;

    // Flexible column mapping — handle various header names
    function getVal(row, ...keys) {
      for (const k of keys) {
        if (row[k] !== undefined && row[k] !== '') return row[k];
        // Case-insensitive fallback
        const lk = k.toLowerCase();
        for (const rk of Object.keys(row)) {
          if (rk.toLowerCase() === lk && row[rk] !== undefined && row[rk] !== '') return row[rk];
        }
      }
      return '';
    }

    // Group rows by product code
    const productMap = {};
    for (const row of rows) {
      const productCode = String(getVal(row, 'Product code', 'Product Code', 'product_code', 'ProductCode') || '').trim();
      if (!productCode) continue;

      if (!productMap[productCode]) {
        productMap[productCode] = {
          product_code: productCode,
          name: String(getVal(row, 'Product Name', 'Product_Name', 'product_name', 'ProductName') || productCode).trim(),
          batch_size: parseFloat(getVal(row, 'Batch size', 'Batch Size', 'batch_size', 'BatchSize')) || 1000,
          yield_percent: parseFloat(getVal(row, 'Yield%', 'Yield', 'yield_percent', 'YieldPercent')) || 0.97,
          sku_size: parseFloat(getVal(row, 'Pack/SKU', 'PackSKU', 'sku_size', 'SKU', 'Pack')) || 1,
          client_name: String(getVal(row, 'Client', 'client_name', 'ClientName') || '').trim(),
          items: [],
        };
        // Convert yield from decimal (0.97) to percent (97) if needed
        if (productMap[productCode].yield_percent <= 1) {
          productMap[productCode].yield_percent = productMap[productCode].yield_percent * 100;
        }
      }

      const matCode = String(getVal(row, 'Material Code', 'material_code', 'MaterialCode') || '').trim();
      const matName = String(getVal(row, 'Material Name', 'material_name', 'MaterialName') || '').trim();
      const rawQty  = parseFloat(getVal(row, 'QTY', 'Qty', 'quantity', 'Quantity')) || 0;
      const rawUom  = String(getVal(row, 'UCM/UOM', 'UOM', 'uom', 'Uom') || 'Kg').trim();
      const type    = String(getVal(row, 'Type(RM/PM)', 'Type', 'type', 'category', 'Category') || 'RM').trim();

      if (!matName && !matCode) continue;

      productMap[productCode].items.push({
        material_code: matCode,
        material_name: matName || matCode,
        quantity: rawQty,
        uom: rawUom,
        category: type === 'PM' ? 'PM' : type === 'CG' ? 'CG' : 'RM',
      });
    }

    const results = { products_created: 0, products_updated: 0, bom_items: 0, errors: [] };

    for (const [code, prod] of Object.entries(productMap)) {
      try {
        // Find or create product
        let { data: product } = await supabase
          .from('products')
          .select('id')
          .eq('product_code', code)
          .eq('company_id', company_id)
          .maybeSingle();

        if (!product) {
          const { data: created, error: crErr } = await supabase
            .from('products')
            .insert({
              product_code: code,
              name: prod.name,
              batch_size: prod.batch_size,
              batch_size_uom: 'Kg',
              yield_percent: prod.yield_percent,
              sku_size: prod.sku_size,
              sku_uom: 'units',
              client_name: prod.client_name,
              company_id,
            })
            .select().single();
          if (crErr) throw crErr;
          product = created;
          results.products_created++;
        } else {
          results.products_updated++;
        }

        // Build BOM items
        const bomItems = [];
        for (const item of prod.items) {
          const { qty, uom } = normalizeUOM(item.uom, item.quantity);

          // Find material by code
          let material = null;
          if (item.material_code) {
            const { data } = await supabase
              .from('material_master')
              .select('id, product_code, material_name, category')
              .eq('product_code', item.material_code)
              .eq('company_id', company_id)
              .maybeSingle();
            material = data;
          }

          if (!material) {
            // Auto-create with CST code
            const cstCode = await generateCSTCode(company_id);
            const { data: created } = await supabase
              .from('material_master')
              .insert({
                product_code: cstCode,
                material_name: item.material_name,
                uom, category: item.category,
                initial_price: 0, is_temp_code: true, company_id,
              })
              .select().single();
            material = created;
          }

          bomItems.push({
            product_id: product.id,
            material_id: material.id,
            material_code: material.product_code,
            material_name: material.material_name,
            quantity: qty, uom,
            category: item.category,
            is_frozen: false,
          });
        }

        // Replace existing BOM for this product
        await supabase.from('bom_items').delete().eq('product_id', product.id);
        if (bomItems.length > 0) {
          const { error: insErr } = await supabase.from('bom_items').insert(bomItems);
          if (insErr) throw insErr;
        }

        results.bom_items += bomItems.length;
      } catch (prodErr) {
        results.errors.push({ product_code: code, error: prodErr.message });
      }
    }

    res.json({
      message: `Bulk upload complete: ${results.products_created} products created, ${results.products_updated} updated, ${results.bom_items} BOM items`,
      ...results,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── PUT /api/bom/:productId/freeze ────────────────────────────
router.put('/:productId/freeze', requireAdmin, async (req, res) => {
  try {
    const user_name = req.user.name || req.user.email;
    const { freeze = true } = req.body;

    const { data, error } = await supabase
      .from('products')
      .update({
        is_bom_frozen:  freeze,
        bom_frozen_at:  freeze ? new Date().toISOString() : null,
        bom_frozen_by:  freeze ? user_name : null,
      })
      .eq('id', req.params.productId)
      .eq('company_id', req.user.company_id)
      .select().single();
    if (error) throw error;

    res.json({ message: freeze ? 'BOM frozen successfully' : 'BOM unfrozen', product: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/bom/:productId/item ─────────────────────────────
router.post('/:productId/item', requireAdmin, async (req, res) => {
  try {
    const { material_code, material_name, quantity, uom, category, sub_category } = req.body;
    const company_id = req.user.company_id;
    const { qty: normQty, uom: normUom } = normalizeUOM(uom || 'Kg', quantity);

    // Find or create material
    let material = null;
    if (material_code) {
      const { data } = await supabase
        .from('material_master')
        .select('*')
        .eq('product_code', material_code.trim())
        .eq('company_id', company_id)
        .maybeSingle();
      material = data;
    }
    if (!material) {
      const cstCode = await generateCSTCode(company_id);
      const { data } = await supabase
        .from('material_master')
        .insert({ product_code: cstCode, material_name: material_name || 'Unknown', uom: normUom,
                  category: category || 'RM', is_temp_code: true, initial_price: 0, company_id })
        .select().single();
      material = data;
    }

    const { data, error } = await supabase
      .from('bom_items')
      .insert({
        product_id:    req.params.productId,
        material_id:   material.id,
        material_code: material.product_code,
        material_name: material.material_name,
        quantity:      normQty, uom: normUom,
        category:      category || material.category || 'RM',
        sub_category:  sub_category || null,
      })
      .select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/bom/:productId/item/:itemId ──────────────────────
router.put('/:productId/item/:itemId', requireAdmin, async (req, res) => {
  try {
    const { quantity, uom, category, sub_category } = req.body;
    const { qty: normQty, uom: normUom } = normalizeUOM(uom || 'Kg', quantity);
    const { data, error } = await supabase
      .from('bom_items')
      .update({ quantity: normQty, uom: normUom, category, sub_category })
      .eq('id', req.params.itemId)
      .eq('product_id', req.params.productId)
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/bom/:productId/item/:itemId ───────────────────
router.delete('/:productId/item/:itemId', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('bom_items')
      .delete()
      .eq('id', req.params.itemId)
      .eq('product_id', req.params.productId);
    if (error) throw error;
    res.json({ message: 'Item removed from BOM' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
