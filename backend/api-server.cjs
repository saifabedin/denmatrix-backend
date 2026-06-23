const dotenv = require('dotenv');
const { join } = require('path');

dotenv.config({ path: join(__dirname, '../.env') });

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger.cjs');

const healthRouter = require('./health.cjs');
const authRoutes = require('./routes/auth.cjs');
const requestLogger = require('./middleware/requestLogger.cjs');
const { validateRequiredEnv } = require('./utils/env-validator.cjs');
const { allowedOrigins } = require('./config/security.cjs');
const securityHeaders = require('./middleware/securityHeaders.cjs');

// SECURITY: validate critical env vars at startup. Logs warnings for missing
// optional vars. NEVER logs the values themselves.
const envReport = validateRequiredEnv();
if (!envReport.ok) {
  logger.error(`API server starting with ${envReport.missing.length} missing required env var(s) — some features will fail`, {
    correlationId: 'SYSTEM',
    metadata: { type: 'env_validation_summary', severity: 'critical', count: envReport.missing.length },
  });
}

const app = express();

// ---------------------------------------------------------------------------
// Global error handlers (must be registered before express listeners)
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined,
    correlationId: 'SYSTEM',
  });
  // Non-fatal: just log, do not exit
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', {
    message: err.message,
    stack: err.stack,
    correlationId: 'SYSTEM',
  });
  // Fatal: gracefully shutdown
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Middleware setup
// ---------------------------------------------------------------------------
// Trust Nginx reverse proxy for accurate IP in rate limiting
app.set('trust proxy', 1);
app.use(helmet());
app.use(securityHeaders);
app.use(cors({
origin: function (origin, callback) {
if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
callback(new Error('Not allowed by CORS'))
},
credentials: true,
}));
// Mount billing FIRST (before express.json) so webhook can use express.raw()
app.use('/api/billing', require('./routes/billing.cjs'));

app.use(express.json({ limit: '2mb' }));

// Request tracing with correlation IDs
app.use(requestLogger);

const limiter = rateLimit({
windowMs: 15 * 60 * 1000,
max: 100,
message: 'Too many requests from this IP, please try again later.',
});

app.use('/api/', limiter);

const authLimiter = rateLimit({
windowMs: 15 * 60 * 1000,
max: 10,
message: 'Too many authentication attempts, please try again later.',
});

app.use('/auth', authLimiter);

// Serve frontend static files from built dist
app.use(express.static(join(__dirname, '../frontend/dist')));
app.use('/videos', express.static(join(__dirname, '../public/videos')));
app.use('/images', express.static(join(__dirname, '../public/images')));

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../frontend/dist/index.html'));
});

app.use('/', healthRouter);

app.use('/auth', authRoutes);

// Keep orchestrator open in local/dev so frontend can call it directly.
app.use('/api', require('./routes/orchestrator.cjs'));
app.use('/api/admin', require('./routes/admin.cjs'));
app.use('/api/onboarding', require('./routes/onboarding.cjs'));
// Knowledge graph (vault parser - authenticated)
app.use('/api', require('./routes/knowledge-graph.cjs'));
// Agent shared memory layer
app.use('/api', require('./routes/agent-memory.cjs'));
// Knowledge Galaxy + Collaboration + Lessons + System Health
app.use('/api', require('./routes/galaxy.cjs'));
app.use('/api', require('./routes/agents.cjs'));
// Proxy to ai-team gateway (4100) for CRM, SDR, Voice, Proposals, Research
app.use('/api/team', require('./routes/ai-team-proxy.cjs'));

// Centralized error handling middleware
app.use((err, req, res, next) => {
  const logMeta = {
    err,
    correlationId: req.correlationId,
    jobId: req.jobId,
  };
  logger.error(err.message, logMeta);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal Server Error',
    ...(req.correlationId && { correlationId: req.correlationId }),
    ...(req.jobId && { jobId: req.jobId }),
  });
});

let server;
const PORT = process.env.API_PORT || 4000;
server = app.listen(PORT, () => {
  logger.info(`API Server running on port ${PORT}`, {
    port: PORT,
    env: process.env.NODE_ENV || 'development',
    correlationId: 'SYSTEM',
  });
});

// RELIABILITY: graceful shutdown for SIGTERM/SIGINT
let isApiShuttingDown = false;
async function gracefulApiShutdown(signal) {
  if (isApiShuttingDown) {
    logger.warn(`[API] Shutdown already in progress, ignoring ${signal}`, {
      correlationId: 'SYSTEM',
      metadata: { type: 'api_shutdown_duplicate' },
    });
    return;
  }
  isApiShuttingDown = true;

  logger.info(`[API] ${signal} received, closing server (max 30s)...`, {
    correlationId: 'SYSTEM',
    metadata: { type: 'api_shutdown', signal },
  });

  const forceExitTimeout = setTimeout(() => {
    logger.error(`[API] Graceful shutdown timeout exceeded (30s), forcing exit`, {
      correlationId: 'SYSTEM',
      metadata: { type: 'api_shutdown_timeout' },
    });
    process.exit(1);
  }, 30000);
  forceExitTimeout.unref();

  try {
    await new Promise((resolve) => server.close(resolve));
    logger.info(`[API] HTTP server closed`, { correlationId: 'SYSTEM' });
  } catch (closeErr) {
    logger.error(`[API] server.close() failed: ${closeErr.message}`, {
      correlationId: 'SYSTEM',
      stack: closeErr.stack,
    });
  }

  clearTimeout(forceExitTimeout);
  logger.info(`[API] Graceful shutdown complete`, { correlationId: 'SYSTEM' });
  process.exit(0);
}

process.on('SIGTERM', () => gracefulApiShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulApiShutdown('SIGINT'));

module.exports = app;