import Notification from '../models/Notification.js';


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


export const markNotificationsRead = async (req, res) => {
    try {
        const { notificationIds } = req.body || {};

        const query = { userId: req.user._id };
        if (Array.isArray(notificationIds) && notificationIds.length > 0) {
            query._id = { $in: notificationIds };
        }

        await Notification.updateMany(query, { $set: { read: true } });

        res.json({ message: 'Notifications marked as read' });
    } catch (error) {
        console.error('Mark notifications read error:', error);
        res.status(500).json({ message: 'Error marking notifications as read', error: error.message });
    }
};


export const deleteNotifications = async (req, res) => {
    try {
        const { notificationIds } = req.body || {};

        const query = { userId: req.user._id };
        if (Array.isArray(notificationIds) && notificationIds.length > 0) {
            query._id = { $in: notificationIds };
        }

        await Notification.deleteMany(query);

        res.json({ message: 'Notifications deleted successfully' });
    } catch (error) {
        console.error('Delete notifications error:', error);
        res.status(500).json({ message: 'Error deleting notifications', error: error.message });
    }
}; 