const express = require('express');
const supabase = require('../supabase');
const { authenticate, checkLicense } = require('../middleware/auth');

const router = express.Router();

// All product routes require auth + active license
router.use(authenticate, checkLicense);

// GET /api/products — list all products for this company
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('company_id', req.user.company_id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/products — create new product
router.post('/', async (req, res) => {
  const { name, category, description, batch_size, batch_unit } = req.body;
  if (!name) return res.status(400).json({ error: 'Product name required' });
  const { data, error } = await supabase
    .from('products')
    .insert({ name, category, description, batch_size, batch_unit, company_id: req.user.company_id, created_by: req.user.id })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/products/:id
router.put('/:id', async (req, res) => {
  const { name, category, description, batch_size, batch_unit } = req.body;
  const { data, error } = await supabase
    .from('products')
    .update({ name, category, description, batch_size, batch_unit, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('company_id', req.user.company_id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/products/:id
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.user.company_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Deleted' });
});

module.exports = router;
