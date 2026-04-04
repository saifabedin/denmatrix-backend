/**
 * EC Engine 5: Image Generation
 *
 * Calls Replicate API directly (Flux Pro) then fires the n8n
 * webhook for downstream logging and publishing.
 *
 * POST /api/engines/image-generation/run
 * Body: {
 *   brand_id : UUID,
 *   input: {
 *     prompt     : string   (required)
 *     style      : string   (optional — e.g. "photorealistic", "illustration")
 *     dimensions : string   (optional — "1:1" | "16:9" | "9:16", default "1:1")
 *     num_images : number   (optional, default 1, max 4)
 *   }
 * }
 *
 * Env: REPLICATE_API_TOKEN
 */

const { Router } = require('express');
const axios  = require('axios');
const { v4: uuidv4 } = require('uuid');
const { authenticateJWT } = require('../../middleware/auth');
const { requireBrandId, verifyBrandOwnership } = require('../../middleware/brandId');
const { engineRateLimiter } = require('../../middleware/rateLimiter');
const { triggerWorkflow } = require('../../utils/n8n');
const { query } = require('../../config/db');
const { success, createError } = require('../../utils/response');
const logger = require('../../utils/logger');

const router     = Router();
const SLUG       = 'image-generation';
const MIDDLEWARE = [authenticateJWT, requireBrandId, verifyBrandOwnership, engineRateLimiter];

// Dimension presets → Flux Pro width/height
const DIMENSION_MAP = {
  '1:1':  { width: 1024, height: 1024 },
  '16:9': { width: 1344, height: 768  },
  '9:16': { width: 768,  height: 1344 },
  '4:3':  { width: 1024, height: 768  },
  '3:4':  { width: 768,  height: 1024 },
};

// ─── Replicate helper ─────────────────────────────────────────────────────────

async function startReplicatePrediction({ prompt, style, dimensions = '1:1', num_images = 1 }) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('REPLICATE_API_TOKEN is not configured');

  const { width, height } = DIMENSION_MAP[dimensions] || DIMENSION_MAP['1:1'];
  const fullPrompt = style ? `${prompt}, ${style} style` : prompt;

  const body = {
    input: {
      prompt:         fullPrompt,
      width,
      height,
      num_outputs:    Math.min(Math.max(1, num_images || 1), 4),
      output_format:  'webp',
      output_quality: 90,
    }
  };

  // Flux Pro via model-level endpoint — Prefer: wait=30 for sync result
  const response = await axios.post(
    'https://api.replicate.com/v1/models/black-forest-labs/flux-pro/predictions',
    body,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Prefer':        'wait=30'
      },
      timeout: 35000
    }
  );

  return response.data;  // { id, status, output, urls, ... }
}

// ─── POST /run ────────────────────────────────────────────────────────────────
router.post('/run', ...MIDDLEWARE, async (req, res, next) => {
  const brand_id = req.brand_id;
  const { input = {} } = req.body;
  const { prompt, style, dimensions, num_images } = input;
  const job_id = uuidv4();

  if (!prompt) {
    return next(createError('VALIDATION_ERROR', 'input.prompt is required', 400));
  }

  logger.info('Image generation started', { brand_id, job_id, prompt: prompt.slice(0, 80) });

  try {
    const prediction    = await startReplicatePrediction({ prompt, style, dimensions, num_images });
    const image_url     = Array.isArray(prediction.output) ? prediction.output[0] : (prediction.output || null);
    const prediction_id = prediction.id;
    const rep_status    = prediction.status; // 'succeeded' | 'starting' | 'processing'

    // Persist to engine_jobs
    await query(
      `INSERT INTO engine_jobs (job_id, brand_id, engine_slug, status, payload, result, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (job_id) DO NOTHING`,
      [
        job_id, brand_id, SLUG,
        rep_status === 'succeeded' ? 'done' : 'queued',
        JSON.stringify({ prompt, style, dimensions, prediction_id }),
        image_url ? JSON.stringify({ image_url, prediction_id, all_outputs: prediction.output }) : null
      ]
    ).catch(e => logger.warn('engine_jobs insert failed', { error: e.message }));

    // Fire n8n webhook for downstream (non-blocking)
    triggerWorkflow(SLUG, brand_id, {
      job_id, prediction_id, image_url, prompt, style, dimensions, status: rep_status
    }).catch(e => logger.warn('n8n trigger failed (non-fatal)', { error: e.message }));

    return success(res, {
      brand_id,
      engine_id:         SLUG,
      job_id,
      prediction_id,
      status:            rep_status === 'succeeded' ? 'done' : 'queued',
      image_url,
      estimated_seconds: rep_status === 'succeeded' ? 0 : 25
    }, 202);

  } catch (err) {
    logger.error('Image generation failed', { brand_id, job_id, error: err.message });
    return next(createError('ENGINE_RUN_FAILED', err.message, 502));
  }
});

// ─── GET /status/:job_id ──────────────────────────────────────────────────────
router.get('/status/:job_id', ...MIDDLEWARE, async (req, res, next) => {
  const { job_id } = req.params;
  const brand_id   = req.brand_id;
  const token      = process.env.REPLICATE_API_TOKEN;

  try {
    const dbResult = await query(
      `SELECT job_id, brand_id, engine_slug, status, payload, result, created_at, updated_at
       FROM engine_jobs WHERE job_id = $1 AND brand_id = $2`,
      [job_id, brand_id]
    );

    if (!dbResult.rows.length) {
      return next(createError('JOB_NOT_FOUND', `Job ${job_id} not found`, 404));
    }

    const job = dbResult.rows[0];

    // If still queued and we have a prediction_id, poll Replicate for live status
    if (job.status === 'queued' && job.payload?.prediction_id && token) {
      try {
        const rep  = await axios.get(
          `https://api.replicate.com/v1/predictions/${job.payload.prediction_id}`,
          { headers: { 'Authorization': `Bearer ${token}` }, timeout: 8000 }
        );
        const pred      = rep.data;
        const done      = pred.status === 'succeeded';
        const image_url = done && Array.isArray(pred.output) ? pred.output[0] : null;

        if (done || pred.status === 'failed') {
          await query(
            `UPDATE engine_jobs SET status = $1, result = $2, updated_at = NOW() WHERE job_id = $3`,
            [done ? 'done' : 'failed', image_url ? JSON.stringify({ image_url, all_outputs: pred.output }) : null, job_id]
          ).catch(() => {});
          job.status = done ? 'done' : 'failed';
          job.result = image_url ? { image_url } : null;
        }
      } catch { /* Replicate poll failed — return DB state */ }
    }

    return success(res, {
      brand_id,
      engine_id:  SLUG,
      job_id:     job.job_id,
      status:     job.status,
      image_url:  job.result?.image_url || null,
      result:     job.result,
      created_at: job.created_at,
      updated_at: job.updated_at
    });
  } catch (err) {
    next(createError('STATUS_FETCH_FAILED', err.message, 500));
  }
});

module.exports = router;
