const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '15');

function fileFilter(req, file, cb) {
  if (ALLOWED_MIME.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, WebP, and PDF allowed.'));
  }
}

function imageOnlyFilter(req, file, cb) {
  const imageMime = ['image/jpeg', 'image/png', 'image/webp'];
  if (imageMime.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Images only: JPEG, PNG, or WebP.'));
  }
}

// Disk storage — for local uploads (ID docs, transaction docs)
function makeDiskStorage(subfolder) {
  return multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads'), subfolder);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });
}

// Disk upload — used for ID docs and transaction docs
function upload(subfolder) {
  return multer({
    storage: makeDiskStorage(subfolder),
    fileFilter,
    limits: { fileSize: MAX_MB * 1024 * 1024 },
  });
}

// Memory upload — used when files go to R2 (photos, item images)
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: imageOnlyFilter,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

// Video upload — MP4 only, 50 MB cap, for First Impression videos
const videoUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'video/mp4') cb(null, true);
    else cb(new Error('Only MP4 videos are accepted'));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

module.exports = { upload, memoryUpload, videoUpload };
