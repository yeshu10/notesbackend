import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  serveAttachment,
  deleteAttachment,
} from '../controllers/attachmentController.js';

const router = express.Router();

// GET    /api/attachments/:attachmentId/file  — stream file (auth + note access verified)
router.get('/:attachmentId/file', auth, serveAttachment);

// DELETE /api/attachments/:attachmentId       — remove attachment + GridFS file
router.delete('/:attachmentId', auth, deleteAttachment);

export default router;
