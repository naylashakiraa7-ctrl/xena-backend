const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== DATABASE CONNECTION (Supabase PostgreSQL) =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== TEST CONNECTION =====
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'OK',
      message: 'Xena.io API is running',
      database: 'Connected',
      time: result.rows[0].now
    });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', message: error.message });
  }
});

// ===== REGISTER =====
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Semua field wajib diisi' });
    }

    const checkUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (checkUser.rows.length > 0) {
      return res.status(400).json({ message: 'Email sudah terdaftar' });
    }

    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 10);
    const referralCode = 'XENA-' + Math.random().toString(36).substring(2, 8).toUpperCase();

    const result = await pool.query(
      `INSERT INTO users (name, email, password, role, referral_code, balance) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, name, email, role, referral_code, balance`,
      [name, email, hashedPassword, role || 'user', referralCode, 0]
    );

    const user = result.rows[0];
    const token = Buffer.from(`${user.id}:${Date.now()}`).toString('base64');

    res.status(201).json({
      message: 'Registrasi berhasil!',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        referral_code: user.referral_code,
        balance: parseFloat(user.balance)
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== LOGIN =====
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email dan password wajib diisi' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Email atau password salah' });
    }

    const user = result.rows[0];

    if (user.status === 'blocked') {
      return res.status(403).json({ message: 'Akun Anda diblokir' });
    }

    const bcrypt = require('bcryptjs');
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ message: 'Email atau password salah' });
    }

    const token = Buffer.from(`${user.id}:${Date.now()}`).toString('base64');

    res.json({
      message: 'Login berhasil!',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        referral_code: user.referral_code,
        balance: parseFloat(user.balance)
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== GET USER PROFILE =====
app.get('/api/users/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Token required' });
    }

    const userId = parseInt(Buffer.from(token, 'base64').toString().split(':')[0]);
    if (!userId) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const result = await pool.query(
      'SELECT id, name, email, role, status, balance, referral_code FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== GET ALL TASKS =====
app.get('/api/tasks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tasks ORDER BY level, id');
    res.json({ tasks: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== GET TASKS BY LEVEL =====
app.get('/api/tasks/level/:level', async (req, res) => {
  try {
    const { level } = req.params;
    const result = await pool.query('SELECT * FROM tasks WHERE level = $1 AND status = $2', [level, 'active']);
    res.json({ tasks: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== COMPLETE TASK =====
app.post('/api/tasks/complete', async (req, res) => {
  try {
    const { task_id } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Token required' });
    }

    const userId = parseInt(Buffer.from(token, 'base64').toString().split(':')[0]);
    if (!userId) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const taskResult = await pool.query('SELECT reward FROM tasks WHERE id = $1', [task_id]);
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ message: 'Task tidak ditemukan' });
    }

    const reward = parseFloat(taskResult.rows[0].reward);

    const checkResult = await pool.query(
      'SELECT * FROM user_tasks WHERE user_id = $1 AND task_id = $2 AND status = $3',
      [userId, task_id, 'completed']
    );
    if (checkResult.rows.length > 0) {
      return res.status(400).json({ message: 'Task sudah selesai dikerjakan' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'INSERT INTO user_tasks (user_id, task_id, status, completed_at) VALUES ($1, $2, $3, NOW())',
        [userId, task_id, 'completed']
      );

      await client.query(
        'UPDATE users SET balance = balance + $1 WHERE id = $2',
        [reward, userId]
      );

      const balanceResult = await client.query(
        'SELECT balance FROM users WHERE id = $1',
        [userId]
      );

      await client.query('COMMIT');

      res.json({
        message: 'Task selesai!',
        reward: reward,
        new_balance: parseFloat(balanceResult.rows[0].balance)
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== GET USER TASKS HISTORY =====
app.get('/api/users/tasks', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Token required' });
    }

    const userId = parseInt(Buffer.from(token, 'base64').toString().split(':')[0]);
    if (!userId) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const result = await pool.query(
      `SELECT ut.*, t.name, t.type, t.reward 
       FROM user_tasks ut 
       JOIN tasks t ON ut.task_id = t.id 
       WHERE ut.user_id = $1 
       ORDER BY ut.created_at DESC`,
      [userId]
    );

    res.json({ history: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== REQUEST WITHDRAWAL =====
app.post('/api/withdrawals', async (req, res) => {
  try {
    const { method, detail, amount } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Token required' });
    }

    const userId = parseInt(Buffer.from(token, 'base64').toString().split(':')[0]);
    if (!userId) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    if (!method || !detail || !amount || amount < 15) {
      return res.status(400).json({ message: 'Minimal penarikan $15' });
    }

    const balanceResult = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);
    const balance = parseFloat(balanceResult.rows[0].balance);
    if (amount > balance) {
      return res.status(400).json({ message: 'Saldo tidak mencukupi' });
    }

    const result = await pool.query(
      `INSERT INTO withdrawals (user_id, method, detail, amount, status) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, method, detail, amount, status, created_at`,
      [userId, method, detail, amount, 'pending']
    );

    res.status(201).json({
      message: 'Penarikan berhasil diajukan!',
      withdrawal: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== GET USER WITHDRAWALS =====
app.get('/api/withdrawals', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Token required' });
    }

    const userId = parseInt(Buffer.from(token, 'base64').toString().split(':')[0]);
    if (!userId) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const result = await pool.query(
      'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );

    res.json({ withdrawals: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== CLAIM COUPON =====
app.post('/api/coupons/claim', async (req, res) => {
  try {
    const { code } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'Token required' });
    }

    const userId = parseInt(Buffer.from(token, 'base64').toString().split(':')[0]);
    if (!userId) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    if (!code) {
      return res.status(400).json({ message: 'Kode kupon wajib diisi' });
    }

    const couponResult = await pool.query(
      'SELECT * FROM coupons WHERE code = $1 AND status = $2',
      [code.toUpperCase(), 'active']
    );
    if (couponResult.rows.length === 0) {
      return res.status(400).json({ message: 'Kode kupon tidak valid atau sudah kadaluarsa' });
    }

    const coupon = couponResult.rows[0];
    if (coupon.used >= coupon.quota) {
      return res.status(400).json({ message: 'Kuota kupon sudah habis' });
    }

    const checkResult = await pool.query(
      'SELECT * FROM user_coupons WHERE user_id = $1 AND coupon_id = $2',
      [userId, coupon.id]
    );
    if (checkResult.rows.length > 0) {
      return res.status(400).json({ message: 'Anda sudah mengklaim kupon ini' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'UPDATE coupons SET used = used + 1 WHERE id = $1',
        [coupon.id]
      );

      await client.query(
        'INSERT INTO user_coupons (user_id, coupon_id) VALUES ($1, $2)',
        [userId, coupon.id]
      );

      const rewardText = coupon.reward;
      const rewardMatch = rewardText.match(/\d+(\.\d+)?/);
      if (rewardMatch) {
        const rewardAmount = parseFloat(rewardMatch[0]);
        await client.query(
          'UPDATE users SET balance = balance + $1 WHERE id = $2',
          [rewardAmount, userId]
        );
      }

      await client.query('COMMIT');

      res.json({
        message: '🎉 Kupon berhasil diklaim!',
        reward: coupon.reward
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== ADMIN: GET ALL COUPONS =====
app.get('/api/admin/coupons', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json({ coupons: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== ADMIN: CREATE COUPON =====
app.post('/api/admin/coupons', async (req, res) => {
  try {
    const { code, reward, quota } = req.body;
    if (!code || !reward || !quota) {
      return res.status(400).json({ message: 'Semua field wajib diisi' });
    }

    const result = await pool.query(
      'INSERT INTO coupons (code, reward, quota, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [code.toUpperCase(), reward, quota, 'active']
    );

    res.status(201).json({
      message: 'Kupon berhasil dibuat!',
      coupon: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== ADMIN: DELETE COUPON =====
app.delete('/api/admin/coupons/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const result = await pool.query('DELETE FROM coupons WHERE code = $1 RETURNING *', [code]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Kupon tidak ditemukan' });
    }
    res.json({ message: 'Kupon berhasil dihapus' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== ADMIN: GET ALL WITHDRAWALS =====
app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT w.*, u.name as user_name, u.email as user_email 
       FROM withdrawals w 
       JOIN users u ON w.user_id = u.id 
       ORDER BY w.created_at DESC`
    );
    res.json({ withdrawals: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== ADMIN: UPDATE WITHDRAWAL STATUS =====
app.put('/api/admin/withdrawals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'completed', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Status tidak valid' });
    }

    const result = await pool.query(
      'UPDATE withdrawals SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Penarikan tidak ditemukan' });
    }

    res.json({
      message: 'Status penarikan diperbarui',
      withdrawal: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== ADMIN: GET ALL USERS =====
app.get('/api/admin/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, status, balance, referral_code, created_at FROM users ORDER BY id'
    );
    res.json({ users: result.rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== ADMIN: BLOCK/UNBLOCK USER =====
app.put('/api/admin/users/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'blocked'].includes(status)) {
      return res.status(400).json({ message: 'Status tidak valid' });
    }

    const result = await pool.query(
      'UPDATE users SET status = $1 WHERE id = $2 RETURNING id, name, email, status',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User tidak ditemukan' });
    }

    res.json({
      message: `User ${status === 'active' ? 'diaktifkan' : 'diblokir'}`,
      user: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`🚀 Xena.io API running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
});