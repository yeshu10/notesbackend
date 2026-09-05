import rateLimit from 'express-rate-limit';

// Key generator that safely resolves client IP address
const getClientIp = (req) => {
    return (
        req.ip ||
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.socket?.remoteAddress ||
        '127.0.0.1'
    );
};

// General API Rate Limiter
export const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // limit each IP to 1000 requests per 15 minutes
    message: { message: 'Too many requests from this IP, please try again after 15 minutes' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getClientIp,
    skip: (req) => {
        if (req.method === 'OPTIONS') return true;
        if (req.path && (req.path.startsWith('/socket.io') || req.path === '/')) return true;
        return false;
    }
});

// Strict limiter for auth routes
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 attempts per 15 minutes
    message: { message: 'Too many login/register attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getClientIp,
    skip: (req) => req.method === 'OPTIONS'
});

// Global app limiter
export const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1500, // limit each IP to 1500 requests per 15 minutes
    message: { message: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getClientIp,
    skip: (req) => {
        if (req.method === 'OPTIONS') return true;
        if (req.path && (req.path.startsWith('/socket.io') || req.path === '/')) return true;
        return false;
    }
});

