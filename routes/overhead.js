const express = require('express');
const supabase = require('../supabase');
const { authenticate, checkLicense } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate, checkLicense);

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('overhead_templates').select('*').eq('company_id', req.user.company_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', async (req, res) => {
  const { name, type, value, unit, notes } = req.body;
  const { data, error } = await supabase.from('overhead_templates').insert({ name, type, value, unit, notes, company_id: req.user.company_id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:id', async (req, res) => {
  const { name, type, value, unit, notes } = req.body;
  const { data, error } = await supabase.from('overhead_templates').update({ name, type, value, unit, notes }).eq('id', req.params.id).eq('company_id', req.user.company_id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('overhead_templates').delete().eq('id', req.params.id).eq('company_id', req.user.company_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Deleted' });
});

module.exports = router;
