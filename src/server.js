import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import connectDB from './config/db.js';
import authRoutes from './routes/auth.js';
import noteRoutes from './routes/notes.js';
import { socketHandler, initializeSocket } from './socket/handler.js';
import { initializeArchiver } from './cron/noteArchiver.js';

// Load env vars
dotenv.config();

// Connect to database
connectDB();
// Connect to database

const app = express();
// Trust proxy (needed for cloud environments like Render)
app.set('trust proxy', 1);
const httpServer = createServer(app);

// Socket.io setup
const io = new Server(httpServer, {
  cors: {
    origin: function(origin, callback) {
      // Allow requests with no origin (like mobile apps, curl requests)
      if (!origin) return callback(null, true);
      
      // Allowed origins
      const allowedOrigins = [
        process.env.FRONTEND_URL || 'https://notesfrontend-topaz.vercel.app',
        'http://localhost:5173'
      ];
      
      // Allow any Vercel preview URL
      if (origin.match(/^https:\/\/notesfrontend-.*\.vercel\.app$/)) {
        return callback(null, true);
      }
      
      // Check against allowed origins
      if (allowedOrigins.indexOf(origin) !== -1) {
        return callback(null, true);
      }
      
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  },
  allowEIO3: true,
  transports: ['websocket', 'polling'],
  pingTimeout: 30000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 1e8
});

// Initialize socket handler with io instance
initializeSocket(io);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true // Trust X-Forwarded-For header
});

// Middleware
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl requests)
    if (!origin) return callback(null, true);
    
    // Allowed origins
    const allowedOrigins = [
      process.env.FRONTEND_URL || 'https://notesfrontend-topaz.vercel.app',
      'http://localhost:5173'
    ];
    
    // Allow any Vercel preview URL
    if (origin.match(/^https:\/\/notesfrontend-.*\.vercel\.app$/)) {
      return callback(null, true);
    }
    
    // Check against allowed origins
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use(express.json());
app.use(morgan('dev'));
app.use(limiter);

// Add a simple health check route
app.get('/', (req, res) => {
  res.status(200).json({ 
    message: 'API is running',
    env: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/notes', noteRoutes);

// 404 handler for unmatched routes
app.use((req, res, next) => {
  console.log(`Route not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ 
    message: 'Route not found',
    path: req.originalUrl
  });
});

// Socket.io connection handler
io.on('connection', socketHandler);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
}); 