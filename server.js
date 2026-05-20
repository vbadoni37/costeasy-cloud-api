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
const itemMasterRoutes = require('./routes/itemMaster');
const priceMasterRoutes = require('./routes/priceMaster');
const productMasterRoutes = require('./routes/productMaster');
const bomRoutes = require('./routes/bom');
const codeMappingRoutes  = require('./routes/codeMapping');
const valueMappingRoutes = require('./routes/valueMapping');

const app = express();

// ── CORS ──────────────────────────────────────
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://costeasy-cloud.vercel.app',
  process.env.FRONTEND_URL,
];

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return cb(null, true);
    // Allow any vercel.app subdomain (covers preview deployments too)
    if (origin.endsWith('.vercel.app')) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    console.warn('CORS blocked origin:', origin);
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
app.use('/api/item-master', itemMasterRoutes);
app.use('/api/price-master', priceMasterRoutes);
app.use('/api/product-master', productMasterRoutes);
app.use('/api/bom', bomRoutes);
app.use('/api/code-mapping', codeMappingRoutes);
app.use('/api/value-mapping', valueMappingRoutes);

// ── Global Error Handler ──────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 CostEasy Cloud backend running on http://localhost:${PORT}`);
  console.log(`   Database : Supabase`);
  console.log(`   Mode     : ${process.env.NODE_ENV || 'development'}\n`);
});
