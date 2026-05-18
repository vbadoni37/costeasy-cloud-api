const jwt = require('jsonwebtoken');
const supabase = require('../supabase');

/**
 * Verifies JWT token and attaches user to req.user
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, email, role, company_id }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Checks that the user's license is still valid
 * Attaches license info to req.license
 */
async function checkLicense(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

  const { data: license, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('company_id', req.user.company_id)
    .eq('is_active', true)
    .single();

  if (error || !license) {
    return res.status(403).json({
      error: 'No active license found. Please email blvttech@gmail.com to obtain a license key.',
      code: 'NO_LICENSE',
    });
  }

  const expiryDate = new Date(license.expires_at);
  if (expiryDate < new Date()) {
    return res.status(403).json({
      error: 'Your license has expired. Please email blvttech@gmail.com to renew.',
      code: 'LICENSE_EXPIRED',
      expired_at: license.expires_at,
    });
  }

  req.license = license;
  next();
}

module.exports = { authenticate, checkLicense };
