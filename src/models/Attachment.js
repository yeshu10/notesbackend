import mongoose from 'mongoose';

/**
 * Attachment — metadata only.
 * Binary data is stored in GridFS (bucket: "attachments").
 * gridfsId is the ObjectId of the GridFS file document.
 */
const attachmentSchema = new mongoose.Schema(
  {
    noteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Note',
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    originalName: {
      type: String,
      required: true,
      trim: true,
    },
    mimeType: {
      type: String,
      required: true,
    },
    fileSize: {
      type: Number,
      required: true,
    },
    /** ObjectId pointing to the file document inside GridFS "attachments" bucket */
    gridfsId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    /** Safe, collision-free filename used as the GridFS filename (hex + ext) */
    filename: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Efficient lookup by note and chronological order
attachmentSchema.index({ noteId: 1, createdAt: 1 });
attachmentSchema.index({ gridfsId: 1 });

const Attachment = mongoose.model('Attachment', attachmentSchema);

export default Attachment;
