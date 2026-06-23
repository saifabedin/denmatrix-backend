// backend/controllers/billing.cjs
const Razorpay = require('razorpay');
const crypto = require('crypto');
const pool = require('../db/client.cjs');
const logger = require('../utils/logger.cjs');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

async function getPlans(req, res) {
  try {
    const result = await pool.query('SELECT plan_id, name, price_monthly, features FROM plans WHERE plan_id IS NOT NULL ORDER BY price_monthly ASC');
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    logger.error(`[Billing] getPlans: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Failed to fetch plans' });
  }
}

async function createSubscription(req, res) {
  try {
    const { plan_id } = req.body;
    const tenantId = req.user.tenant_id;

    const planRes = await pool.query('SELECT * FROM plans WHERE plan_id = $1', [plan_id]);
    if (!planRes.rows.length) {
      return res.status(400).json({ success: false, error: 'Invalid plan' });
    }
    const plan = planRes.rows[0];

    if (!plan.razorpay_plan_id) {
      return res.status(400).json({ success: false, error: 'Razorpay plan not configured. Run seed-plans script.' });
    }

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan.razorpay_plan_id,
      total_count: 12,
      notes: { tenant_id: String(tenantId), plan_id },
    });

    await pool.query(
      `INSERT INTO subscriptions (tenant_id, plan_id, razorpay_subscription_id, status)
       VALUES ($1, $2, $3, 'created')
       ON CONFLICT (razorpay_subscription_id) DO NOTHING`,
      [tenantId, plan_id, subscription.id]
    );

    await pool.query(
      'UPDATE tenants SET razorpay_subscription_id = $1, plan_id = $2, updated_at = NOW() WHERE id = $3',
      [subscription.id, plan_id, tenantId]
    );

    return res.json({
      success: true,
      data: {
        subscription_id: subscription.id,
        razorpay_key: process.env.RAZORPAY_KEY_ID,
        plan_name: plan.name,
        amount: plan.price_monthly,
      }
    });
  } catch (err) {
    logger.error(`[Billing] createSubscription: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Failed to create subscription' });
  }
}

// NOTE: Webhook signature verification uses JSON.stringify(req.body) because
// express.json() is applied globally before this route. This is less secure
// than verifying against the raw bytes. To harden, mount the billing router
// BEFORE express.json() and use express.raw() on this route only.
async function handleWebhook(req, res) {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const body = JSON.stringify(req.body);
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');

    if (signature !== expected) {
      logger.warn('[Billing] Invalid webhook signature');
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }

    const event = req.body;
    const subId = event?.payload?.subscription?.entity?.id;
    const tenantRes = subId
      ? await pool.query('SELECT id FROM tenants WHERE razorpay_subscription_id = $1', [subId])
      : { rows: [] };
    const tenantId = tenantRes.rows[0]?.id || null;

    await pool.query(
      `INSERT INTO billing_events (tenant_id, event_type, razorpay_event_id, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (razorpay_event_id) DO NOTHING`,
      [tenantId, event.event, event.id, JSON.stringify(event)]
    );

    if (tenantId) {
      if (event.event === 'subscription.activated') {
        await pool.query(`UPDATE tenants SET subscription_status='active', updated_at=NOW() WHERE id=$1`, [tenantId]);
      } else if (['subscription.cancelled', 'subscription.completed'].includes(event.event)) {
        await pool.query(`UPDATE tenants SET subscription_status='cancelled', updated_at=NOW() WHERE id=$1`, [tenantId]);
      } else if (event.event === 'subscription.halted') {
        await pool.query(`UPDATE tenants SET subscription_status='suspended', updated_at=NOW() WHERE id=$1`, [tenantId]);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error(`[Billing] webhook error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Webhook error' });
  }
}

async function getBillingStatus(req, res) {
  try {
    const tenantId = req.user.tenant_id;
    const result = await pool.query(
      `SELECT t.plan_id, t.subscription_status, t.razorpay_subscription_id,
              t.trial_ends_at, p.name as plan_name, p.price_monthly, p.features
       FROM tenants t
       LEFT JOIN plans p ON t.plan_id::text = p.plan_id
       WHERE t.id = $1`,
      [tenantId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }
    return res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    logger.error(`[Billing] getBillingStatus: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Failed to get billing status' });
  }
}

module.exports = { getPlans, createSubscription, handleWebhook, getBillingStatus };
