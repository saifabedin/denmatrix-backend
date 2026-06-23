require('../initEnv.cjs');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger.cjs');

const HF_TOKEN = process.env.HF_TOKEN;
const HF_MODEL_URL = 'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell';
const IMAGES_DIR = path.join(__dirname, '../../public/images');
const BASE_URL = process.env.APP_URL || 'https://fixmyleads.in';

// Ensure output dir exists
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Save binary buffer to public/images/, return public URL
function saveImage(buffer) {
  const filename = `gen-${crypto.randomBytes(8).toString('hex')}.jpg`;
  fs.writeFileSync(path.join(IMAGES_DIR, filename), buffer);
  return `${BASE_URL}/images/${filename}`;
}

// Primary: HuggingFace FLUX.1-schnell
async function generateViaHuggingFace(prompt) {
  if (!HF_TOKEN) throw new Error('HF_TOKEN not set');

  logger.info(`[ImageGen] HuggingFace: ${prompt.slice(0, 80)}...`);

  const res = await fetch(HF_MODEL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs: prompt }),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HuggingFace ${res.status}: ${err.slice(0, 200)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1000) throw new Error('HuggingFace returned empty image');

  const url = saveImage(buffer);
  logger.info(`[ImageGen] HuggingFace done → ${url}`);
  return url;
}

// Fallback: Pollinations.ai (no API key, returns URL directly)
async function generateViaPollinations(prompt) {
  logger.info(`[ImageGen] Pollinations fallback: ${prompt.slice(0, 80)}...`);

  const encoded = encodeURIComponent(prompt.slice(0, 500));
  const url = `https://image.pollinations.ai/prompt/${encoded}?model=flux&width=1024&height=1024&nologo=true&enhance=true`;

  const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`Pollinations ${res.status}`);

  // Pollinations returns binary too — save it for consistent URL pattern
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1000) throw new Error('Pollinations returned empty image');

  const imageUrl = saveImage(buffer);
  logger.info(`[ImageGen] Pollinations done → ${imageUrl}`);
  return imageUrl;
}

// Main export — try HF first, fall back to Pollinations
async function generateImage(prompt) {
  try {
    return await generateViaHuggingFace(prompt);
  } catch (hfErr) {
    logger.warn(`[ImageGen] HuggingFace failed (${hfErr.message}) — trying Pollinations`);
    try {
      return await generateViaPollinations(prompt);
    } catch (pollErr) {
      throw new Error(`Both providers failed. HF: ${hfErr.message} | Pollinations: ${pollErr.message}`);
    }
  }
}

module.exports = { generateImage };
