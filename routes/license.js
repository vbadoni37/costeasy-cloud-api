const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const supabase = require('../supabase');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/license/status ──────────────────────────────────
// Check license status for logged-in user's company
router.get('/status', authenticate, async (req, res) => {
  const { data: license, error } = await supabase
    .from('licenses')
    .select('key, expires_at, is_active, activated_at, company_id')
    .eq('company_id', req.user.company_id)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !license) {
    return res.json({
      status: 'none',
      message: 'No active license. Please email blvttech@gmail.com to purchase a license key.',
    });
  }

  const expiry = new Date(license.expires_at);
  const now = new Date();
  const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

  return res.json({
    status: expiry >= now ? 'valid' : 'expired',
    expires_at: license.expires_at,
    activated_at: license.activated_at,
    days_left: Math.max(0, daysLeft),
  });
});

// ── POST /api/license/activate ───────────────────────────────
// Customer enters their license key
router.post('/activate', authenticate, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'License key required' });

  const cleanKey = key.trim().toUpperCase();

  // Find the license by key
  const { data: license, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('key', cleanKey)
    .single();

  if (error || !license) {
    return res.status(404).json({ error: 'Invalid license key. Please check and try again.' });
  }

  if (license.company_id && license.company_id !== req.user.company_id) {
    return res.status(403).json({ error: 'This license key is registered to a different company.' });
  }

  if (license.is_active && new Date(license.expires_at) >= new Date()) {
    return res.json({ message: 'License already active.', expires_at: license.expires_at });
  }

  // Activate: assign to this company, set 1-year expiry
  const now = new Date();
  const oneYearLater = new Date(now);
  oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);

  const { error: updateErr } = await supabase
    .from('licenses')
    .update({
      company_id: req.user.company_id,
      is_active: true,
      activated_at: now.toISOString(),
      expires_at: oneYearLater.toISOString(),
    })
    .eq('key', cleanKey);

  if (updateErr) {
    return res.status(500).json({ error: 'Failed to activate license. Please contact support.' });
  }

  return res.json({
    message: '✅ License activated successfully! Valid for 1 year.',
    expires_at: oneYearLater.toISOString(),
  });
});

// ── GET /api/license/request-info ────────────────────────────
// Returns the email address and instructions for getting a license
router.get('/request-info', (req, res) => {
  res.json({
    contact_email: 'blvttech@gmail.com',
    subject: 'CostEasy Cloud License Request',
    instructions: [
      '1. Send an email to blvttech@gmail.com',
      '2. Include your company name and the admin email you registered with',
      '3. You will receive a license key within 24 hours',
      '4. The license key is valid for 1 year from the date of activation',
    ],
  });
});

module.exports = router;
