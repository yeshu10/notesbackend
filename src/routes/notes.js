import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  getNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  shareNote
} from '../controllers/noteController.js';

const router = express.Router();

router.get('/', auth, getNotes);
router.post('/', auth, createNote);
router.get('/:id', auth, getNote);
router.patch('/:id', auth, updateNote);
router.delete('/:id', auth, deleteNote);
router.post('/:id/share', auth, shareNote);

export default router; 