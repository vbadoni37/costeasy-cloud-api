const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const supabase = require('../supabase');

const router = express.Router();

// ── Admin Auth Middleware ─────────────────────────────────────
function requireAdmin(req, res, next) {
  const password = req.headers['x-admin-password'];
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized. Admin password required.' });
  }
  next();
}

// ── POST /api/admin/generate-key ─────────────────────────────
// Generate a new license key and store in Supabase
router.post('/generate-key', requireAdmin, async (req, res) => {
  const { company_name, customer_email, notes } = req.body;
  if (!customer_email) return res.status(400).json({ error: 'customer_email required' });

  // Generate a unique key: CEPY-XXXX-XXXX-XXXX
  const rawKey = crypto.randomBytes(8).toString('hex').toUpperCase();
  const key = `CEPY-${rawKey.slice(0,4)}-${rawKey.slice(4,8)}-${rawKey.slice(8,12)}`;

  // Store in Supabase (not yet activated — customer activates on first use)
  const { data, error } = await supabase
    .from('licenses')
    .insert({
      key,
      customer_email: customer_email.toLowerCase(),
      company_name: company_name || null,
      is_active: false,
      notes: notes || null,
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: 'Failed to store license key: ' + error.message });
  }

  // ── Send key via email ──────────────────────────────────────
  let emailSent = false;
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: customer_email,
      subject: '🔑 Your CostEasy Cloud License Key',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #1e3a5f, #2563eb); padding: 32px; border-radius: 12px 12px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 24px;">CostEasy Cloud</h1>
            <p style="color: #93c5fd; margin: 8px 0 0 0;">Pharma Product Costing Software</p>
          </div>
          <div style="background: #f8fafc; padding: 32px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
            <h2 style="color: #1e293b;">Your License Key is Ready! 🎉</h2>
            ${company_name ? `<p style="color: #475569;">Dear <strong>${company_name}</strong> team,</p>` : ''}
            <p style="color: #475569;">Thank you for choosing CostEasy Cloud. Your license key is:</p>
            
            <div style="background: white; border: 2px dashed #2563eb; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0;">
              <code style="font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #1e3a5f;">${key}</code>
            </div>
            
            <h3 style="color: #1e293b;">How to Activate:</h3>
            <ol style="color: #475569; line-height: 1.8;">
              <li>Log in to CostEasy Cloud at your company URL</li>
              <li>Click <strong>"Enter License Key"</strong> on the dashboard</li>
              <li>Enter the key above and click <strong>Activate</strong></li>
              <li>Your license will be valid for <strong>1 year</strong> from today</li>
            </ol>
            
            <div style="background: #fef9c3; border: 1px solid #fde047; border-radius: 8px; padding: 16px; margin: 24px 0;">
              <strong>⚠️ Important:</strong> Keep this key safe. It is linked to your company account and cannot be reused on another account.
            </div>
            
            <p style="color: #64748b; font-size: 14px;">For support, reply to this email or contact us at <a href="mailto:blvttech@gmail.com">blvttech@gmail.com</a></p>
          </div>
        </div>
      `,
    });
    emailSent = true;
  } catch (emailErr) {
    console.error('Email send failed:', emailErr.message);
  }

  res.json({
    key,
    customer_email,
    emailSent,
    message: emailSent
      ? `✅ Key generated and emailed to ${customer_email}`
      : `✅ Key generated. Email failed — share key manually: ${key}`,
    id: data.id,
  });
});

// ── GET /api/admin/licenses ───────────────────────────────────
router.get('/licenses', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('licenses')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /api/admin/revoke-license/:id ─────────────────────
router.delete('/revoke-license/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase
    .from('licenses')
    .update({ is_active: false })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'License revoked.' });
});

// ── GET /api/admin/users ──────────────────────────────────────
router.get('/users', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, role, company_id, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
