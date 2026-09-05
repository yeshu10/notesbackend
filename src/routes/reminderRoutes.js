import express from 'express';
import { auth } from '../middleware/auth.js';
import {
    setReminder,
    getReminders,
    getNoteReminder,
    deleteReminder
} from '../controllers/reminderController.js';

const router = express.Router();

router.use(auth);

router.post('/', setReminder);
router.get('/', getReminders);
router.get('/note/:noteId', getNoteReminder);
router.delete('/note/:noteId', deleteReminder);

export default router;
