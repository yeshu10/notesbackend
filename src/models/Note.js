import mongoose from 'mongoose';

const noteSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  content: {
    type: String,
    required: true
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
      enum: ['read', 'write'],
      default: 'read'
    }
  }],
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  isArchived: {
    type: Boolean,
    default: false
  },
  archivedAt: {
    type: Date
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Update lastUpdated timestamp on save
noteSchema.pre('save', function(next) {
  this.lastUpdated = new Date();
  next();
});

// Index for efficient querying
noteSchema.index({ createdBy: 1, lastUpdated: -1 });
noteSchema.index({ 'collaborators.userId': 1, lastUpdated: -1 });
noteSchema.index({ isArchived: 1, lastUpdated: -1 });

const Note = mongoose.model('Note', noteSchema);

export default Note; 