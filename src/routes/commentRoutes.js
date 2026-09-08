import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  getNoteComments,
  addComment,
  updateComment,
  deleteComment
} from '../controllers/commentController.js';

const router = express.Router({ mergeParams: true });

// Note-scoped comment routes
router.get('/:noteId/comments', auth, getNoteComments);
router.post('/:noteId/comments', auth, addComment);
router.patch('/:noteId/comments/:id', auth, updateComment);
router.delete('/:noteId/comments/:id', auth, deleteComment);

// Direct comment-scoped routes
router.patch('/:id', auth, updateComment);
router.delete('/:id', auth, deleteComment);

export default router;
