import Reminder from '../models/Reminder.js';
import Note from '../models/Note.js';
import mongoose from 'mongoose';

const safeIdEquals = (id1, id2) => {
    if (!id1 || !id2) return false;
    return id1.toString() === id2.toString();
};

// Set or update a reminder for a note
export const setReminder = async (req, res) => {
    try {
        const { noteId, date, time, reminderAt: clientReminderAt } = req.body;
        const userId = req.user._id;

        if (!noteId || !mongoose.Types.ObjectId.isValid(noteId)) {
            return res.status(400).json({ message: 'Valid Note ID is required' });
        }

        const note = await Note.findById(noteId);
        if (!note || note.isTrashed) {
            return res.status(404).json({ message: 'Note not found' });
        }

        // Check permissions: Owner or Editor can set reminders
        const isCreator = safeIdEquals(note.createdBy, userId);
        const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));
        const canEdit = isCreator || (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor'));

        if (!canEdit) {
            return res.status(403).json({ message: 'Permission denied. Only owners and editors can set reminders.' });
        }

        // Calculate reminder Date object
        let reminderDateObj;
        if (clientReminderAt) {
            reminderDateObj = new Date(clientReminderAt);
        } else if (date && time) {
            reminderDateObj = new Date(`${date}T${time}:00`);
        } else {
            return res.status(400).json({ message: 'Date and Time are required' });
        }

        if (isNaN(reminderDateObj.getTime())) {
            return res.status(400).json({ message: 'Invalid Date or Time format' });
        }

        // Check if time is in the past
        if (reminderDateObj <= new Date()) {
            return res.status(400).json({ message: 'Please select a future date and time.' });
        }

        // Upsert reminder (update existing or create new for this user & note)
        const reminder = await Reminder.findOneAndUpdate(
            { noteId, userId },
            {
                reminderAt: reminderDateObj,
                isTriggered: false,
                isCompleted: false,
                isActive: true
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).populate('noteId', 'title content color tags isPinned');

        res.status(200).json(reminder);
    } catch (error) {
        console.error('Set reminder error:', error);
        res.status(500).json({ message: 'Error setting reminder', error: error.message });
    }
};

// Get all active reminders for current user
export const getReminders = async (req, res) => {
    try {
        const userId = req.user._id;

        const reminders = await Reminder.find({
            userId,
            isActive: true,
            isTriggered: false,
            reminderAt: { $gt: new Date() }
        })
            .sort({ reminderAt: 1 })
            .populate({
                path: 'noteId',
                select: 'title content color tags isPinned isArchived isTrashed createdBy collaborators',
                populate: { path: 'createdBy', select: 'name email _id' }
            });

        // Filter out trashed notes
        const activeReminders = reminders.filter(r => r.noteId && !r.noteId.isTrashed);

        res.json(activeReminders);
    } catch (error) {
        console.error('Get reminders error:', error);
        res.status(500).json({ message: 'Error fetching reminders', error: error.message });
    }
};

// Get reminder for a specific note
export const getNoteReminder = async (req, res) => {
    try {
        const { noteId } = req.params;
        const userId = req.user._id;

        if (!mongoose.Types.ObjectId.isValid(noteId)) {
            return res.status(400).json({ message: 'Invalid Note ID' });
        }

        const reminder = await Reminder.findOne({
            noteId,
            userId,
            isActive: true,
            isTriggered: false
        });

        res.json(reminder || null);
    } catch (error) {
        console.error('Get note reminder error:', error);
        res.status(500).json({ message: 'Error fetching note reminder', error: error.message });
    }
};

// Delete / Remove reminder for a note
export const deleteReminder = async (req, res) => {
    try {
        const { noteId } = req.params;
        const userId = req.user._id;

        if (!mongoose.Types.ObjectId.isValid(noteId)) {
            return res.status(400).json({ message: 'Invalid Note ID' });
        }

        const note = await Note.findById(noteId);
        if (note) {
            const isCreator = safeIdEquals(note.createdBy, userId);
            const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));
            const canEdit = isCreator || (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor'));
            if (!canEdit) {
                return res.status(403).json({ message: 'Permission denied. Cannot remove reminder.' });
            }
        }

        await Reminder.findOneAndUpdate(
            { noteId, userId },
            { isActive: false, isTriggered: false }
        );

        res.json({ message: 'Reminder removed successfully' });
    } catch (error) {
        console.error('Delete reminder error:', error);
        res.status(500).json({ message: 'Error deleting reminder', error: error.message });
    }
};
