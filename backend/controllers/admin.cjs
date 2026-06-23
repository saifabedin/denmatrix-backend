// backend/controllers/admin.cjs
const pool = require('../db/client.cjs');
const logger = require('../utils/logger.cjs');

async function getAllUsers(req, res) {
  try {
    const { page = 1, limit = 20, niche, status, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = ['1=1'];
    const params = [];
    let i = 1;

    if (niche) { where.push(`t.niche = $${i++}`); params.push(niche); }
    if (status) { where.push(`t.subscription_status = $${i++}`); params.push(status); }
    if (search) { where.push(`(t.business_name ILIKE $${i} OR u.email ILIKE $${i++})`); params.push(`%${search}%`); }

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM users u JOIN tenants t ON u.tenant_id = t.id WHERE u.is_super_admin = FALSE AND ${where.join(' AND ')}`,
      params
    );

    params.push(parseInt(limit), offset);
    const usersRes = await pool.query(
      `SELECT u.id, u.name, u.email, u.created_at,
              t.id as tenant_id, t.business_name, t.niche, t.plan_id,
              t.subscription_status, t.whatsapp_number, t.onboarding_complete,
              t.trial_ends_at, t.razorpay_subscription_id
       FROM users u
       JOIN tenants t ON u.tenant_id = t.id
       WHERE u.is_super_admin = FALSE AND ${where.join(' AND ')}
       ORDER BY u.created_at DESC
       LIMIT $${i++} OFFSET $${i++}`,
      params
    );

    return res.json({
      success: true,
      data: {
        users: usersRes.rows,
        total: parseInt(countRes.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
      }
    });
  } catch (err) {
    logger.error(`[Admin] getAllUsers error: ${err.message}`, { stack: err.stack });
    return res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
}

async function getUserUsage(req, res) {
  try {
    const { id } = req.params;
    const usageRes = await pool.query(
      `SELECT
         COUNT(*) as total_requests,
         SUM(tokens_used) as total_tokens,
         SUM(cost) as total_cost,
         DATE_TRUNC('month', created_at) as month
       FROM usage_logs
       WHERE user_id = $1
       GROUP BY month
       ORDER BY month DESC
       LIMIT 6`,
      [id]
    );
    return res.json({ success: true, data: usageRes.rows });
  } catch (err) {
    logger.error(`[Admin] getUserUsage error: ${err.message}`, { stack: err.stack });
    return res.status(500).json({ success: false, error: 'Failed to fetch usage' });
  }
}

async function updateUserStatus(req, res) {
  try {
    const { id } = req.params; // tenant_id
    const { status } = req.body;
    const allowed = ['active', 'suspended', 'trial', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }
    await pool.query(
      'UPDATE tenants SET subscription_status = $1, updated_at = NOW() WHERE id = $2',
      [status, id]
    );
    return res.json({ success: true, message: `Tenant status updated to ${status}` });
  } catch (err) {
    logger.error(`[Admin] updateUserStatus error: ${err.message}`, { stack: err.stack });
    return res.status(500).json({ success: false, error: 'Failed to update status' });
  }
}

async function getPlatformStats(req, res) {
  try {
    const [totalUsers, activeUsers, trialUsers, nicheBreakdown, revenueRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM users WHERE is_super_admin = FALSE`),
      pool.query(`SELECT COUNT(*) FROM tenants WHERE subscription_status = 'active'`),
      pool.query(`SELECT COUNT(*) FROM tenants WHERE subscription_status = 'trial'`),
      pool.query(`SELECT niche, COUNT(*) FROM tenants WHERE niche != 'general' GROUP BY niche`),
      pool.query(`SELECT COALESCE(SUM(p.price_monthly), 0) as mrr FROM tenants t JOIN plans p ON t.plan_id::text = p.plan_id WHERE t.subscription_status = 'active'`),
    ]);

    return res.json({
      success: true,
      data: {
        total_users: parseInt(totalUsers.rows[0].count),
        active_users: parseInt(activeUsers.rows[0].count),
        trial_users: parseInt(trialUsers.rows[0].count),
        mrr: parseInt(revenueRes.rows[0].mrr),
        niche_breakdown: nicheBreakdown.rows,
      }
    });
  } catch (err) {
    logger.error(`[Admin] getPlatformStats error: ${err.message}`, { stack: err.stack });
    return res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
}

module.exports = { getAllUsers, getUserUsage, updateUserStatus, getPlatformStats };
