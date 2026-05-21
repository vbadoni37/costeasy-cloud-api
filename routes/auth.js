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

  // ── Auto-notify admin about new registration (fire & forget) ──
  const nodemailer = require('nodemailer');
  const sendNotification = async () => {
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 465, secure: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000,
      });

      // Email TO admin with Reply-To set to customer
      await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: 'blvttech@gmail.com',
        replyTo: email.toLowerCase(),
        subject: `🆕 New Registration: ${company_name} — License Key Needed`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #1e3a5f, #2563eb); padding: 24px; border-radius: 12px 12px 0 0;">
              <h2 style="color: white; margin: 0;">New CostEasy Cloud Registration</h2>
            </div>
            <div style="background: #f8fafc; padding: 28px; border-radius: 0 0 12px 12px; border: 1px solid #e2e8f0;">
              <p style="color: #475569;">A new company has registered and needs a license key:</p>
              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr><td style="padding: 8px 12px; color: #64748b; font-weight: 600;">Company</td><td style="padding: 8px 12px; color: #1e293b; font-weight: 700;">${company_name}</td></tr>
                <tr style="background: #f1f5f9;"><td style="padding: 8px 12px; color: #64748b; font-weight: 600;">Contact</td><td style="padding: 8px 12px; color: #1e293b;">${name}</td></tr>
                <tr><td style="padding: 8px 12px; color: #64748b; font-weight: 600;">Email</td><td style="padding: 8px 12px; color: #2563eb; font-weight: 600;">${email.toLowerCase()}</td></tr>
                <tr style="background: #f1f5f9;"><td style="padding: 8px 12px; color: #64748b; font-weight: 600;">Date</td><td style="padding: 8px 12px; color: #1e293b;">${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>
              </table>
              <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; margin-top: 16px;">
                <strong>👉 Action Required:</strong> Go to <a href="https://costeasy-cloud.vercel.app/admin">Admin Panel</a> to generate and send a license key for this customer.
              </div>
              <p style="color: #94a3b8; font-size: 13px; margin-top: 16px;">💡 Hit Reply to respond directly to the customer.</p>
            </div>
          </div>
        `,
      });
    } catch (err) {
      console.error('Admin notification email failed:', err.message);
    }
  };
  sendNotification(); // fire & forget — don't await

  res.status(201).json({
    message: 'Account created! Your license key request has been sent to the CostEasy team. You will receive your key via email shortly.',
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
