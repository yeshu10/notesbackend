import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { apiLimiter } from '../middleware/rateLimiter.js';
import {
    getNotifications,
    markNotificationsRead,
    deleteNotifications
} from '../controllers/notificationController.js';

const router = express.Router();

// Apply rate limiting to all notification routes
router.use(apiLimiter);

// Protected routes
router.use(protect);

router.route('/')
    .get(getNotifications)
    .delete(deleteNotifications);

router.patch('/read', markNotificationsRead);

export default router; 