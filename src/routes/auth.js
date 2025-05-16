import express from 'express';
import { login, register } from '../controllers/authController.js';

const router = express.Router();

// User registration
router.post('/register', register);

// User login
router.post('/login', login);

export default router; 