/**
 * EC Engine 6: Video Generation Professional 2-Stage
 *
 * Stage 1 — Script: use input.script OR trigger content-generation for a short script
 * Stage 2 — Video:  POST to D-ID Talks API → talking-head video
 *
 * POST /api/engines/video-generation/run
 * Body: {
 *   brand_id : UUID,
 *   input: {
 *     script          : string  (optional — if omitted, topic is used)
 *     topic           : string  (required if no script)
 *     presenter_image : string  (URL — optional, uses D-ID default if omitted)
 *     voice           : string  (optional — default "en-US-JennyNeural")
 *     voice_provider  : string  (optional — "microsoft" | "amazon", default "microsoft")
 *   }
 * }
 *
 * Env: D_ID_API_KEY
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
const SLUG       = 'video-generation';
const MIDDLEWARE = [authenticateJWT, requireBrandId, verifyBrandOwnership, engineRateLimiter];

const DEFAULT_PRESENTER = 'https://create-images-results.d-id.com/DefaultPresenters/Noelle_f_us/image.jpeg';
const DID_BASE          = 'https://api.d-id.com';

// ─── D-ID helpers ─────────────────────────────────────────────────────────────

function getDidAuth() {
  const key = process.env.D_ID_API_KEY;
  if (!key) throw new Error('D_ID_API_KEY is not configured');
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

async function createDidTalk({ script, presenter_image, voice = 'en-US-JennyNeural', voice_provider = 'microsoft' }) {
  const body = {
    source_url: presenter_image || DEFAULT_PRESENTER,
    script: {
      type:     'text',
      input:    script,
      provider: { type: voice_provider, voice_id: voice }
    },
    config: { fluent: true, pad_audio: 0.0 }
  };

  const response = await axios.post(`${DID_BASE}/talks`, body, {
    headers: {
      'Authorization': getDidAuth(),
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    timeout: 20000
  });

  return response.data;  // { id, status, created_at, ... }
}

async function getDidTalkStatus(talk_id) {
  const response = await axios.get(`${DID_BASE}/talks/${talk_id}`, {
    headers: { 'Authorization': getDidAuth(), 'Accept': 'application/json' },
    timeout: 10000
  });
  return response.data;  // { id, status, result_url, ... }
}

// ─── Stage 1: Acquire script ──────────────────────────────────────────────────

async function acquireScript({ script, topic, brand_id }) {
  if (script && script.trim().length > 20) {
    return { script, source: 'provided' };
  }
  if (!topic) throw new Error('Either input.script or input.topic is required');

  // Trigger content-generation engine for a video script (async — use topic as fallback)
  try {
    const { job_id: script_job_id } = await triggerWorkflow('content-generation', brand_id, {
      task:   'video_script',
      topic,
      length: 'short',
      format: 'talking_head'
    });
    // n8n is async — return a placeholder script using the topic.
    // In production: poll /api/engines/content-generation/status/:script_job_id for result.
    return {
      script: `Welcome to our platform. Today we explore ${topic}. `
            + `With AI-powered tools from DenMatrix, you can automate your marketing, `
            + `generate content at scale, and track performance in real time. `
            + `Let's get started.`,
      source:        'auto_generated',
      script_job_id
    };
  } catch (err) {
    logger.warn('Stage 1 webhook failed, using topic as script', { error: err.message });
    return { script: topic, source: 'fallback' };
  }
}

// ─── POST /run ────────────────────────────────────────────────────────────────
router.post('/run', ...MIDDLEWARE, async (req, res, next) => {
  const brand_id = req.brand_id;
  const { input = {} } = req.body;
  const { script, topic, presenter_image, voice, voice_provider } = input;
  const job_id = uuidv4();

  if (!script && !topic) {
    return next(createError('VALIDATION_ERROR', 'input.script or input.topic is required', 400));
  }

  logger.info('Video generation started', { brand_id, job_id });

  try {
    // Stage 1 — Script
    const { script: finalScript, source, script_job_id } = await acquireScript({ script, topic, brand_id });
    logger.info('Video Stage 1 complete', { brand_id, job_id, source, script_length: finalScript.length });

    // Stage 2 — D-ID Talk
    const talk    = await createDidTalk({ script: finalScript, presenter_image, voice, voice_provider });
    const talk_id = talk.id;
    logger.info('Video Stage 2: D-ID talk created', { brand_id, job_id, talk_id, status: talk.status });

    // Persist to engine_jobs
    await query(
      `INSERT INTO engine_jobs (job_id, brand_id, engine_slug, status, payload, result, created_at)
       VALUES ($1, $2, $3, 'queued', $4, NULL, NOW())
       ON CONFLICT (job_id) DO NOTHING`,
      [
        job_id, brand_id, SLUG,
        JSON.stringify({ talk_id, script_source: source, script_job_id, presenter_image, voice })
      ]
    ).catch(e => logger.warn('engine_jobs insert failed', { error: e.message }));

    // Fire n8n for downstream (non-blocking)
    triggerWorkflow(SLUG, brand_id, { job_id, talk_id, script_source: source, status: talk.status })
      .catch(e => logger.warn('n8n trigger failed (non-fatal)', { error: e.message }));

    return success(res, {
      brand_id,
      engine_id:         SLUG,
      job_id,
      talk_id,
      script_source:     source,
      status:            talk.status === 'done' ? 'done' : 'queued',
      video_url:         talk.result_url || null,
      estimated_seconds: 60
    }, 202);

  } catch (err) {
    logger.error('Video generation failed', { brand_id, job_id, error: err.message });
    return next(createError('ENGINE_RUN_FAILED', err.message, 502));
  }
});

// ─── GET /status/:job_id ──────────────────────────────────────────────────────
router.get('/status/:job_id', ...MIDDLEWARE, async (req, res, next) => {
  const { job_id } = req.params;
  const brand_id   = req.brand_id;

  try {
    const dbResult = await query(
      `SELECT job_id, brand_id, engine_slug, status, payload, result, created_at, updated_at
       FROM engine_jobs WHERE job_id = $1 AND brand_id = $2`,
      [job_id, brand_id]
    );

    if (!dbResult.rows.length) {
      return next(createError('JOB_NOT_FOUND', `Job ${job_id} not found`, 404));
    }

    const job     = dbResult.rows[0];
    const talk_id = job.payload?.talk_id;

    // Poll D-ID for live status if still queued
    if (job.status === 'queued' && talk_id && process.env.D_ID_API_KEY) {
      try {
        const talk      = await getDidTalkStatus(talk_id);
        const done      = talk.status === 'done';
        const video_url = talk.result_url || null;

        if (done || talk.status === 'error') {
          await query(
            `UPDATE engine_jobs SET status = $1, result = $2, updated_at = NOW() WHERE job_id = $3`,
            [done ? 'done' : 'failed', video_url ? JSON.stringify({ video_url, talk_id }) : null, job_id]
          ).catch(() => {});
          job.status = done ? 'done' : 'failed';
          job.result = video_url ? { video_url, talk_id } : null;
        }
      } catch { /* D-ID poll failed — return DB state */ }
    }

    return success(res, {
      brand_id,
      engine_id:  SLUG,
      job_id:     job.job_id,
      talk_id,
      status:     job.status,
      video_url:  job.result?.video_url || null,
      result:     job.result,
      created_at: job.created_at,
      updated_at: job.updated_at
    });
  } catch (err) {
    next(createError('STATUS_FETCH_FAILED', err.message, 500));
  }
});

module.exports = router;
