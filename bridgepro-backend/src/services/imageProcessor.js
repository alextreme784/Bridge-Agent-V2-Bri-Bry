const sharp = require('sharp');

const THUMB_WIDTH = 400;
const FULL_WIDTH = 1200;
const THUMB_QUALITY = 75;
const FULL_QUALITY = 85;

async function processPhoto(inputBuffer) {
  const [thumb, optimized] = await Promise.all([
    sharp(inputBuffer)
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer(),
    sharp(inputBuffer)
      .resize({ width: FULL_WIDTH, withoutEnlargement: true })
      .webp({ quality: FULL_QUALITY })
      .toBuffer(),
  ]);
  return { thumb, optimized };
}

// Smaller thumbnail for item images (square crop)
async function processItemImage(inputBuffer) {
  const [thumb, optimized] = await Promise.all([
    sharp(inputBuffer)
      .resize({ width: 300, height: 300, fit: 'cover' })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer(),
    sharp(inputBuffer)
      .resize({ width: 800, withoutEnlargement: true })
      .webp({ quality: FULL_QUALITY })
      .toBuffer(),
  ]);
  return { thumb, optimized };
}

async function processLogo(inputBuffer) {
  return sharp(inputBuffer)
    .resize({ width: 400, height: 200, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
}

module.exports = { processPhoto, processItemImage, processLogo };
