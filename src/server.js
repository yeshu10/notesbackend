import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

import connectDB from './config/db.js';
import authRoutes from './routes/auth.js';
import noteRoutes from './routes/notes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import { socketHandler, initializeSocket } from './socket/handler.js';
import { initializeArchiver } from './cron/noteArchiver.js';
import { globalLimiter } from './middleware/rateLimiter.js';


// Load env vars
dotenv.config();

// Connect to database
connectDB();
// Initialize cron jobs
initializeArchiver();

const app = express();

// Trust proxy (needed for cloud environments like Render)
app.set('trust proxy', 1);
const httpServer = createServer(app);

// Socket.io setup
const io = new Server(httpServer, {
  cors: {
    origin: function (origin, callback) {
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

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const allowedOrigins = [
      process.env.FRONTEND_URL || 'https://notesfrontend-topaz.vercel.app',
      'http://localhost:5173'
    ];
    if (origin.match(/^https:\/\/notesfrontend-.*\.vercel\.app$/)) {
      return callback(null, true);
    }
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));

// Additional middleware specifically for OPTIONS requests
app.options('*', (req, res) => {
  const origin = req.headers.origin;
  if (origin?.match(/^https:\/\/notesfrontend-.*\.vercel\.app$/) ||
    origin === process.env.FRONTEND_URL ||
    origin === 'http://localhost:5173') {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.status(200).send();
  } else {
    res.status(403).send('CORS not allowed');
  }
});

// Custom CORS headers middleware (ensures headers are set for all responses)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin?.match(/^https:\/\/notesfrontend-.*\.vercel\.app$/) ||
    origin === process.env.FRONTEND_URL ||
    origin === 'http://localhost:5173') {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  next();
});

app.use(express.json());
app.use(morgan('dev'));
app.use(globalLimiter);

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
app.use('/api/notifications', notificationRoutes);

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

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use by another Node process.`);
    console.error(`👉 To free port ${PORT} on Windows PowerShell, run:`);
    console.error(`   Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force\n`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
  }
});

httpServer.listen(PORT, () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
}); 