import mongoose from 'mongoose';

const noteVersionSchema = new mongoose.Schema({
    noteId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Note',
        required: true,
        index: true
    },
    title: {
        type: String,
        default: 'Untitled Note',
        trim: true
    },
    type: {
        type: String,
        enum: ['text', 'checklist'],
        default: 'text'
    },
    content: {
        type: String,
        default: ''
    },
    checklistItems: [{
        id: { type: String },
        text: { type: String, default: '' },
        completed: { type: Boolean, default: false }
    }],
    editedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    versionNumber: {
        type: Number,
        required: true
    },
    changeType: {
        type: String,
        enum: ['created', 'updated', 'restored'],
        default: 'updated'
    },
    sessionId: {
        type: String,
        default: null
    }
}, {
    timestamps: true
});

noteVersionSchema.index({ noteId: 1, versionNumber: -1 });

const NoteVersion = mongoose.model('NoteVersion', noteVersionSchema);

export default NoteVersion;
