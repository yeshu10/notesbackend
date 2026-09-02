import mongoose from 'mongoose';

const noteSchema = new mongoose.Schema({
  title: {
    type: String,
    default: 'Untitled Note',
    trim: true
  },
  content: {
    type: String,
    default: ''
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  collaborators: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    permission: {
      type: String,
      enum: ['read', 'write', 'editor', 'viewer'],
      default: 'read'
    }
  }],
  tags: [{
    type: String,
    trim: true
  }],
  isPinned: {
    type: Boolean,
    default: false
  },
  isFavorite: {
    type: Boolean,
    default: false
  },
  isArchived: {
    type: Boolean,
    default: false
  },
  archivedAt: {
    type: Date
  },
  isTrashed: {
    type: Boolean,
    default: false
  },
  trashedAt: {
    type: Date
  },
  color: {
    type: String,
    default: 'default'
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Update lastUpdated timestamp on save
noteSchema.pre('save', function (next) {
  this.lastUpdated = new Date();
  next();
});

// Indexes for high performance querying
noteSchema.index({ createdBy: 1, isTrashed: 1, isArchived: 1, lastUpdated: -1 });
noteSchema.index({ 'collaborators.userId': 1, isTrashed: 1, isArchived: 1, lastUpdated: -1 });
noteSchema.index({ tags: 1 });
noteSchema.index({ title: 'text', content: 'text', tags: 'text' });

const Note = mongoose.model('Note', noteSchema);

export default Note;
