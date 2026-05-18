const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');

const router = express.Router();

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  // Fetch user from Supabase
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .single();

  if (error || !user)
    return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid)
    return res.status(401).json({ error: 'Invalid email or password' });

  // Check license before granting token
  const { data: license } = await supabase
    .from('licenses')
    .select('expires_at, is_active')
    .eq('company_id', user.company_id)
    .eq('is_active', true)
    .single();

  let licenseStatus = 'none';
  if (license) {
    const expiry = new Date(license.expires_at);
    licenseStatus = expiry >= new Date() ? 'valid' : 'expired';
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, company_id: user.company_id },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, company_id: user.company_id },
    licenseStatus,
    licenseExpiry: license?.expires_at || null,
  });
});

// ── POST /api/auth/register (first-time company setup) ───────
router.post('/register', async (req, res) => {
  const { name, email, password, company_name } = req.body;
  if (!name || !email || !password || !company_name)
    return res.status(400).json({ error: 'All fields required' });

  // Check if email already exists
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', email.toLowerCase())
    .single();

  if (existing)
    return res.status(409).json({ error: 'Email already registered' });

  // Create company
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .insert({ name: company_name })
    .select()
    .single();

  if (companyErr)
    return res.status(500).json({ error: 'Failed to create company' });

  // Hash password and create user
  const password_hash = await bcrypt.hash(password, 12);
  const { data: user, error: userErr } = await supabase
    .from('users')
    .insert({ name, email: email.toLowerCase(), password_hash, role: 'admin', company_id: company.id })
    .select()
    .single();

  if (userErr)
    return res.status(500).json({ error: 'Failed to create user' });

  res.status(201).json({
    message: 'Account created. Please email blvttech@gmail.com with your company name to get your license key.',
    company_id: company.id,
    user: { id: user.id, name: user.name, email: user.email },
  });
});

// ── POST /api/auth/change-password ───────────────────────────
const { authenticate } = require('../middleware/auth');

router.post('/change-password', authenticate, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'Both passwords required' });

  const { data: user } = await supabase
    .from('users')
    .select('password_hash')
    .eq('id', req.user.id)
    .single();

  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid)
    return res.status(401).json({ error: 'Current password incorrect' });

  const newHash = await bcrypt.hash(new_password, 12);
  await supabase.from('users').update({ password_hash: newHash }).eq('id', req.user.id);

  res.json({ message: 'Password changed successfully' });
});

module.exports = router;
