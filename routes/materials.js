const express = require('express');
const supabase = require('../supabase');
const { authenticate, checkLicense } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, checkLicense);

// GET /api/materials
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('raw_materials')
    .select('*')
    .eq('company_id', req.user.company_id)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/materials
router.post('/', async (req, res) => {
  const { name, type, unit, rate_per_unit, supplier, gst_rate, notes } = req.body;
  if (!name || !unit || rate_per_unit === undefined)
    return res.status(400).json({ error: 'name, unit, rate_per_unit required' });
  const { data, error } = await supabase
    .from('raw_materials')
    .insert({ name, type, unit, rate_per_unit, supplier, gst_rate, notes, company_id: req.user.company_id })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/materials/:id
router.put('/:id', async (req, res) => {
  const { name, type, unit, rate_per_unit, supplier, gst_rate, notes } = req.body;
  const { data, error } = await supabase
    .from('raw_materials')
    .update({ name, type, unit, rate_per_unit, supplier, gst_rate, notes, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('company_id', req.user.company_id)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/materials/:id
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('raw_materials')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.user.company_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Deleted' });
});

module.exports = router;
