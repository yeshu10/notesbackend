import Notification from '../models/Notification.js';

// @desc    Get user's notifications
// @route   GET /api/notifications
// @access  Private
export const getNotifications = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const unreadOnly = req.query.unreadOnly === 'true';

        const query = { 
            userId: req.user._id,
            ...(unreadOnly ? { read: false } : {})
        };

        const totalNotifications = await Notification.countDocuments(query);
        const totalPages = Math.ceil(totalNotifications / limit);

        const notifications = await Notification.find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .populate('noteId', 'title');

        res.json({
            notifications,
            pagination: {
                currentPage: page,
                totalPages,
                totalNotifications,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1
            }
        });
    } catch (error) {
        console.error('Get notifications error:', error);
        res.status(500).json({ message: 'Error fetching notifications', error: error.message });
    }
};

// @desc    Mark notifications as read
// @route   PATCH /api/notifications/read
// @access  Private
export const markNotificationsRead = async (req, res) => {
    try {
        const { notificationIds } = req.body;

        if (!Array.isArray(notificationIds)) {
            return res.status(400).json({ message: 'notificationIds must be an array' });
        }

        await Notification.updateMany(
            {
                _id: { $in: notificationIds },
                userId: req.user._id
            },
            { $set: { read: true } }
        );

        res.json({ message: 'Notifications marked as read' });
    } catch (error) {
        console.error('Mark notifications read error:', error);
        res.status(500).json({ message: 'Error marking notifications as read', error: error.message });
    }
};

// @desc    Delete notifications
// @route   DELETE /api/notifications
// @access  Private
export const deleteNotifications = async (req, res) => {
    try {
        const { notificationIds } = req.body;

        if (!Array.isArray(notificationIds)) {
            return res.status(400).json({ message: 'notificationIds must be an array' });
        }

        await Notification.deleteMany({
            _id: { $in: notificationIds },
            userId: req.user._id
        });

        res.json({ message: 'Notifications deleted successfully' });
    } catch (error) {
        console.error('Delete notifications error:', error);
        res.status(500).json({ message: 'Error deleting notifications', error: error.message });
    }
}; 