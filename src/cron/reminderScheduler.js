import cron from 'node-cron';
import Reminder from '../models/Reminder.js';
import Notification from '../models/Notification.js';
import { getIO } from '../socket/handler.js';

export const initializeReminderScheduler = () => {
    // Run every 15 seconds to check for due reminders
    cron.schedule('*/15 * * * * *', async () => {
        try {
            const now = new Date();
            // Find active, non-triggered reminders that are due
            const dueReminders = await Reminder.find({
                isActive: true,
                isTriggered: false,
                reminderAt: { $lte: now }
            }).populate('noteId');

            for (const reminder of dueReminders) {
                try {
                    const note = reminder.noteId;

                    // Skip if note was deleted or trashed
                    if (!note || note.isTrashed) {
                        reminder.isActive = false;
                        await reminder.save();
                        continue;
                    }

                    // Create Notification document
                    const notification = await Notification.create({
                        userId: reminder.userId,
                        senderId: reminder.userId,
                        noteId: note._id,
                        message: `⏰ Reminder: "${note.title || 'Untitled Note'}"`,
                        type: 'REMINDER',
                        read: false
                    });

                    // Broadcast real-time socket event if recipient is online
                    const io = getIO();
                    if (io) {
                        io.to(`user:${reminder.userId.toString()}`).emit('notification', {
                            _id: notification._id,
                            noteId: note._id,
                            message: notification.message,
                            type: 'REMINDER',
                            read: false,
                            createdAt: notification.createdAt
                        });
                    }

                    // Mark reminder as triggered and completed so it never fires again
                    reminder.isTriggered = true;
                    reminder.isCompleted = true;
                    reminder.isActive = false;
                    await reminder.save();

                    console.log(`⏰ Reminder triggered for note "${note.title}" to user ${reminder.userId}`);
                } catch (err) {
                    console.error(`Error processing reminder ${reminder._id}:`, err);
                }
            }
        } catch (error) {
            console.error('Error in reminder scheduler CRON job:', error);
        }
    });

    console.log('⏰ Reminder Scheduler CRON job initialized');
};
