require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const path = require('path');

const MOCK_MODE = process.env.MOCK_MODE === 'true';
if (MOCK_MODE) console.log('[MOCK MODE] Running with mock data — no MSSQL connection');

const { mockOperators, mockProducts, mockMachineStatus } = MOCK_MODE
  ? require('./mock')
  : { mockOperators: null, mockProducts: null, mockMachineStatus: null };

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbConfig = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let pool = null;

async function getPool() {
  if (pool && pool.connected) return pool;
  pool = await sql.connect(dbConfig);
  return pool;
}

// ── POST /api/login ───────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  if (MOCK_MODE) {
    const op = mockOperators.find(o => o.username === username && o.password === password);
    if (!op) return res.status(401).json({ error: 'Invalid credentials' });
    return res.json({ operatorId: op.id, username: op.username, machineName: op.machine_name });
  }

  try {
    const db = await getPool();
    const result = await db.request()
      .input('username', sql.VarChar, username)
      .input('password', sql.VarChar, password)
      .query(`SELECT id, username, machine_name
              FROM operators
              WHERE username = @username AND password = @password`);

    if (result.recordset.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const op = result.recordset[0];
    res.json({ operatorId: op.id, username: op.username, machineName: op.machine_name });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/products?machine= ────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  const { machine } = req.query;
  if (!machine) return res.status(400).json({ error: 'machine required' });

  if (MOCK_MODE) {
    return res.json(mockProducts.filter(p => p.Machine === machine));
  }

  try {
    const db = await getPool();
    const result = await db.request()
      .input('machine', sql.VarChar, machine)
      .query(`SELECT DISTINCT Product_ID, Flavor
              FROM [product table]
              WHERE Machine = @machine
              ORDER BY Product_ID`);

    res.json(result.recordset);
  } catch (err) {
    console.error('Products error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/flavor?productId= ────────────────────────────────────────────────
app.get('/api/flavor', async (req, res) => {
  const { productId } = req.query;
  if (!productId) return res.status(400).json({ error: 'productId required' });

  if (MOCK_MODE) {
    const product = mockProducts.find(p => p.Product_ID === productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    return res.json({ Flavor: product.Flavor });
  }

  try {
    const db = await getPool();
    const result = await db.request()
      .input('productId', sql.VarChar, productId)
      .query(`SELECT TOP 1 Flavor FROM [product table] WHERE Product_ID = @productId`);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ Flavor: result.recordset[0].Flavor });
  } catch (err) {
    console.error('Flavor error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/machine-status?machine=&date= ────────────────────────────────────
app.get('/api/machine-status', async (req, res) => {
  const { machine, date } = req.query;
  if (!machine || !date) {
    return res.status(400).json({ error: 'machine and date required' });
  }

  if (MOCK_MODE) {
    const match = mockMachineStatus.Machine === machine;
    return res.json(match ? mockMachineStatus : null);
  }

  try {
    const db = await getPool();
    const result = await db.request()
      .input('machine', sql.VarChar, machine)
      .input('date', sql.Date, date)
      .query(`SELECT TOP 1 *
              FROM [Change paper brik]
              WHERE Machine = @machine AND [Product Date] = @date
              ORDER BY id DESC`);

    res.json(result.recordset.length > 0 ? result.recordset[0] : null);
  } catch (err) {
    console.error('Machine-status error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/pending-check ────────────────────────────────────────────────────
app.get('/api/pending-check', (_req, res) => res.sendStatus(200));

// ── POST /api/submit ──────────────────────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  if (MOCK_MODE) {
    console.log('[MOCK] SUBMIT PAYLOAD:', JSON.stringify(req.body, null, 2));
    return res.json({ success: true });
  }

  try {
    const { operatorId, machineName, productId, flavor, productDate, startingBrik, slots } = req.body;

    if (!machineName || !productId || !productDate || !Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const db = await getPool();

    // Check if a row already exists for this machine + product + date
    const checkReq = db.request()
      .input('machine', sql.VarChar, machineName)
      .input('productId', sql.VarChar, productId)
      .input('date', sql.Date, productDate);

    const checkResult = await checkReq.query(`
      SELECT TOP 1 id FROM [Change paper brik]
      WHERE Machine = @machine AND [Product_ID] = @productId AND [Product Date] = @date
    `);

    const request = db.request();

    if (checkResult.recordset.length > 0) {
      // UPDATE existing row — only set the columns for the submitted brik range
      const existingId = checkResult.recordset[0].id;
      request.input('rowId', sql.Int, existingId);

      const setClauses = [];
      slots.forEach((slot, i) => {
        const n = startingBrik + i;
        request.input(`barcode${n}`, sql.VarChar, slot.barcode || null);
        request.input(`depositing${n}`, sql.Text, slot.depositing || null);
        request.input(`opt${n}`, sql.Int, slot.opt != null ? parseInt(slot.opt) : null);
        request.input(`supplier${n}`, sql.Int, slot.supplier != null ? parseInt(slot.supplier) : null);
        setClauses.push(
          `[Barcode ${n}] = @barcode${n}`,
          `[depositing ${n}] = @depositing${n}`,
          `[OPT${n}] = @opt${n}`,
          `[Supplier${n}] = @supplier${n}`
        );
      });

      await request.query(
        `UPDATE [Change paper brik] SET ${setClauses.join(', ')} WHERE id = @rowId`
      );
    } else {
      // INSERT new row with the submitted brik range columns
      request.input('insertDate', sql.Date, productDate);
      request.input('insertProductId', sql.VarChar, productId);
      request.input('insertMachine', sql.VarChar, machineName);
      request.input('insertFlavor', sql.VarChar, flavor);

      const colNames = ['[Product Date]', '[Product_ID]', '[Machine]', '[Flavor]'];
      const paramRefs = ['@insertDate', '@insertProductId', '@insertMachine', '@insertFlavor'];

      slots.forEach((slot, i) => {
        const n = startingBrik + i;
        request.input(`barcode${n}`, sql.VarChar, slot.barcode || null);
        request.input(`depositing${n}`, sql.Text, slot.depositing || null);
        request.input(`opt${n}`, sql.Int, slot.opt != null ? parseInt(slot.opt) : null);
        request.input(`supplier${n}`, sql.Int, slot.supplier != null ? parseInt(slot.supplier) : null);
        colNames.push(`[Barcode ${n}]`, `[depositing ${n}]`, `[OPT${n}]`, `[Supplier${n}]`);
        paramRefs.push(`@barcode${n}`, `@depositing${n}`, `@opt${n}`, `@supplier${n}`);
      });

      await request.query(
        `INSERT INTO [Change paper brik] (${colNames.join(', ')}) VALUES (${paramRefs.join(', ')})`
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// Serve index.html for any non-API route (SPA fallback)
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`UHT Filling app running on http://localhost:${PORT}`));
