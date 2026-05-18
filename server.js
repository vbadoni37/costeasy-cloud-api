require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const licenseRoutes = require('./routes/license');
const productsRoutes = require('./routes/products');
const materialsRoutes = require('./routes/materials');
const costSheetsRoutes = require('./routes/costSheets');
const overheadRoutes = require('./routes/overhead');
const adminRoutes = require('./routes/admin');

const app = express();

// ── CORS ──────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  'https://costeasy.vercel.app',   // update with your Vercel URL
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health Check ──────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', mode: 'cloud', db: 'supabase' });
});

// ── Routes ────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/license', licenseRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/materials', materialsRoutes);
app.use('/api/cost-sheets', costSheetsRoutes);
app.use('/api/overhead', overheadRoutes);
app.use('/api/admin', adminRoutes);

// ── Global Error Handler ──────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 CostEasy Cloud backend running on http://localhost:${PORT}`);
  console.log(`   Database : Supabase`);
  console.log(`   Mode     : ${process.env.NODE_ENV || 'development'}\n`);
});
