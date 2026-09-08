import express from 'express';
import { auth } from '../middleware/auth.js';
import { upload, MAX_FILE_SIZE_MB } from '../config/gridfs.js';
import {
  uploadAttachment,
  getAttachments,
} from '../controllers/attachmentController.js';

const router = express.Router({ mergeParams: true });

/**
 * Wrap multer in a custom handler so we can return proper JSON errors
 * instead of Express's default HTML error page.
 */
const multerSingle = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();

    // File too large
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        message: `File exceeds the maximum allowed size of ${MAX_FILE_SIZE_MB} MB`,
      });
    }
    // Unsupported type (thrown by fileFilter)
    if (err.message && err.message.startsWith('Unsupported file type')) {
      return res.status(415).json({ message: err.message });
    }
    // Generic multer / other error
    return res.status(400).json({ message: err.message || 'Upload error' });
  });
};

// POST /api/notes/:noteId/attachments  — upload a file
router.post('/:noteId/attachments', auth, multerSingle, uploadAttachment);

// GET  /api/notes/:noteId/attachments  — list attachments for a note
router.get('/:noteId/attachments', auth, getAttachments);

export default router;
