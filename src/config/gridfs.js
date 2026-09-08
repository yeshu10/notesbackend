import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import multer from 'multer';
import path from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum allowed file size: 10 MB */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_SIZE_MB = 10;

/** Allowed MIME types */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

/** Allowed file extensions (must match MIME types) */
export const ALLOWED_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg',
  '.pdf', '.txt', '.doc', '.docx',
];

// ─── GridFS Bucket (lazy singleton) ──────────────────────────────────────────

let _bucket = null;

/**
 * Returns the GridFSBucket instance backed by the existing Mongoose connection.
 * Call this only after the database is connected.
 */
export const getGridFSBucket = () => {
  if (!_bucket) {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('MongoDB not connected — cannot initialise GridFS bucket');
    }
    _bucket = new GridFSBucket(mongoose.connection.db, { bucketName: 'attachments' });
  }
  return _bucket;
};

// ─── Multer middleware (memoryStorage) ───────────────────────────────────────

/**
 * Validate file type on the multer level (first line of defence).
 * A second validation is performed in the controller.
 *
 * NOTE: multer v2 uses an async fileFilter — return true to accept,
 * throw an Error to reject. The old (v1) callback style no longer works.
 */
const fileFilter = async (req, file) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype) || !ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Unsupported file type "${file.mimetype}". ` +
      `Allowed: JPEG, PNG, WEBP, GIF, SVG, PDF, TXT, DOC, DOCX`
    );
  }
  return true;
};

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter,
});
