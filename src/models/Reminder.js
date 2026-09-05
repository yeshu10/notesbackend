import mongoose from 'mongoose';

const reminderSchema = new mongoose.Schema({
    noteId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Note',
        required: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    reminderAt: {
        type: Date,
        required: true,
        index: true
    },
    isTriggered: {
        type: Boolean,
        default: false,
        index: true
    },
    isCompleted: {
        type: Boolean,
        default: false
    },
    isActive: {
        type: Boolean,
        default: true,
        index: true
    }
}, {
    timestamps: true
});

// Indexes for high-performance scheduling and queries
reminderSchema.index({ userId: 1, isActive: 1, isTriggered: 1, reminderAt: 1 });
reminderSchema.index({ noteId: 1, userId: 1 });
reminderSchema.index({ isTriggered: 1, isActive: 1, reminderAt: 1 });

const Reminder = mongoose.model('Reminder', reminderSchema);

export default Reminder;
