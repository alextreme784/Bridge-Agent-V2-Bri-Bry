const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

function r2Configured() {
  const id = process.env.R2_ACCOUNT_ID || '';
  return id.length > 0 && !id.startsWith('your-');
}

// ── R2 path ──────────────────────────────────────────────────────────────────

let client;
function getClient() {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

// ── Local disk fallback (dev only) ───────────────────────────────────────────

const LOCAL_MEDIA_DIR = path.join(
  process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads'),
  'media'
);

function localUrl(key) {
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}/media/${key}`;
}

async function uploadLocal(buffer, folder, extension) {
  const key = `${folder}/${crypto.randomUUID()}${extension}`;
  const dest = path.join(LOCAL_MEDIA_DIR, key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  return { key, url: localUrl(key) };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function uploadBuffer(buffer, folder, extension, contentType) {
  if (!r2Configured()) return uploadLocal(buffer, folder, extension);

  const key = `${folder}/${crypto.randomUUID()}${extension}`;
  await getClient().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000',
  }));
  return { key, url: `${process.env.R2_PUBLIC_URL}/${key}` };
}

async function deleteObject(key) {
  if (!r2Configured()) {
    const filePath = path.join(LOCAL_MEDIA_DIR, key);
    fs.rmSync(filePath, { force: true });
    return;
  }
  await getClient().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
  }));
}

function keyFromUrl(url) {
  const port = process.env.PORT || 3000;
  const localBase = `http://localhost:${port}/media/`;
  if (url.startsWith(localBase)) return url.slice(localBase.length);

  const base = process.env.R2_PUBLIC_URL;
  return url.startsWith(base) ? url.slice(base.length + 1) : null;
}

module.exports = { uploadBuffer, deleteObject, keyFromUrl };
