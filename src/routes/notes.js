import express from 'express';
import { auth } from '../middleware/auth.js';
import {
  getNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  restoreNote,
  emptyTrash,
  shareNote,
  removeCollaborator,
  searchUsers,
  getUserTags,
  getNoteVersions,
  getNoteVersion,
  restoreNoteVersion
} from '../controllers/noteController.js';

const router = express.Router();

// General note list & creation
router.get('/', auth, getNotes);
router.post('/', auth, createNote);

// Tags & User search
router.get('/tags', auth, getUserTags);
router.get('/users/search', auth, searchUsers);

// Trash management
router.delete('/trash/empty', auth, emptyTrash);

// Specific note operation routes
router.get('/:id', auth, getNote);
router.patch('/:id', auth, updateNote);
router.delete('/:id', auth, deleteNote);
router.patch('/:id/restore', auth, restoreNote);

// Version History routes
router.get('/:id/versions', auth, getNoteVersions);
router.get('/:id/versions/:versionId', auth, getNoteVersion);
router.post('/:id/versions/:versionId/restore', auth, restoreNoteVersion);

// Sharing & Collaborator management
router.post('/:id/share', auth, shareNote);
router.delete('/:id/share/:collaboratorId', auth, removeCollaborator);

export default router;