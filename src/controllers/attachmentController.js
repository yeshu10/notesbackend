import mongoose from 'mongoose';
import { Readable } from 'stream';
import path from 'path';
import crypto from 'crypto';
import Note from '../models/Note.js';
import Attachment from '../models/Attachment.js';
import {
  getGridFSBucket,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_MB,
} from '../config/gridfs.js';
import { getIO } from '../socket/handler.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const safeIdEquals = (id1, id2) => {
  if (!id1 || !id2) return false;
  try {
    const s1 = id1._id ? String(id1._id) : String(id1);
    const s2 = id2._id ? String(id2._id) : String(id2);
    return s1 === s2;
  } catch (e) {
    return false;
  }
};

/**
 * Load a Note, verify the requesting user has access, and return
 * permission level ('owner' | 'editor' | 'viewer') plus the note document.
 * Returns { error: 404 | 403 } on failure.
 */
const getNoteWithAccess = async (noteId, userId) => {
  if (!mongoose.Types.ObjectId.isValid(noteId)) {
    return { error: 404, message: 'Note not found' };
  }

  const note = await Note.findById(noteId)
    .populate('createdBy', 'name email _id')
    .populate('collaborators.userId', 'name email _id');

  if (!note) return { error: 404, message: 'Note not found' };

  const isCreator = safeIdEquals(note.createdBy, userId);
  const collaborator = note.collaborators.find(
    (c) => c.userId && safeIdEquals(c.userId, userId)
  );
  const hasAccess = isCreator || collaborator;

  if (!hasAccess) return { error: 403, message: 'Access denied' };

  const permission = isCreator
    ? 'owner'
    : collaborator.permission === 'write' || collaborator.permission === 'editor'
    ? 'editor'
    : 'viewer';

  return { note, isCreator, collaborator, permission };
};

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * POST /api/notes/:noteId/attachments
 * Requires: auth, multer('file') already applied by route.
 * Permissions: owner or editor only.
 */
export const uploadAttachment = async (req, res) => {
  try {
    const { noteId } = req.params;
    const userId = req.user._id;

    // ── 1. Note access check ─────────────────────────────────────────────────
    const { note, permission, error, message } = await getNoteWithAccess(noteId, userId);
    if (error === 404) return res.status(404).json({ message: message || 'Note not found' });
    if (error === 403) return res.status(403).json({ message: 'Access denied' });

    if (note.isTrashed) {
      return res.status(400).json({
        message: 'Cannot add attachments to a trashed note. Restore it first.',
      });
    }

    if (permission === 'viewer') {
      return res.status(403).json({ message: 'Viewers cannot upload attachments' });
    }

    // ── 2. File presence check ───────────────────────────────────────────────
    if (!req.file) {
      return res.status(400).json({ message: 'No file provided' });
    }

    const { originalname, mimetype, size, buffer } = req.file;

    // ── 3. Backend double-validation (never trust frontend alone) ────────────
    const ext = path.extname(originalname).toLowerCase();

    if (!ALLOWED_MIME_TYPES.includes(mimetype)) {
      return res.status(415).json({
        message: `Unsupported file type "${mimetype}". Allowed: JPEG, PNG, WEBP, GIF, SVG, PDF, TXT, DOC, DOCX`,
      });
    }

    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return res.status(415).json({
        message: `Unsupported file extension "${ext}". Allowed: jpg, png, webp, gif, svg, pdf, txt, doc, docx`,
      });
    }

    if (size > MAX_FILE_SIZE_BYTES) {
      return res.status(413).json({
        message: `File exceeds the maximum allowed size of ${MAX_FILE_SIZE_MB} MB`,
      });
    }

    // ── 4. Generate a safe, collision-free storage filename ──────────────────
    const safeFilename = crypto.randomBytes(16).toString('hex') + ext;

    // ── 5. Stream buffer to GridFS ───────────────────────────────────────────
    const bucket = getGridFSBucket();
    const uploadStream = bucket.openUploadStream(safeFilename, {
      contentType: mimetype,
      metadata: {
        originalName: originalname,
        uploadedBy: userId.toString(),
        noteId: noteId,
      },
    });

    const readable = Readable.from(buffer);
    readable.pipe(uploadStream);

    const gridfsId = await new Promise((resolve, reject) => {
      uploadStream.on('finish', () => resolve(uploadStream.id));
      uploadStream.on('error', reject);
    });

    // ── 6. Persist metadata to Attachment collection ─────────────────────────
    const attachment = await Attachment.create({
      noteId,
      uploadedBy: userId,
      originalName: originalname,
      mimeType: mimetype,
      fileSize: size,
      gridfsId,
      filename: safeFilename,
    });

    await attachment.populate('uploadedBy', 'name email _id');

    // ── 7. Broadcast to note room (real-time) ────────────────────────────────
    const io = getIO();
    if (io) {
      io.to(`note:${noteId}`).emit('attachment-added', {
        attachment,
        noteId,
      });
    }

    return res.status(201).json(attachment);
  } catch (error) {
    console.error('uploadAttachment error:', error);
    return res.status(500).json({ message: 'Upload failed', error: error.message });
  }
};

/**
 * GET /api/notes/:noteId/attachments
 * Permissions: any user with note access.
 */
export const getAttachments = async (req, res) => {
  try {
    const { noteId } = req.params;
    const userId = req.user._id;

    const { error, message } = await getNoteWithAccess(noteId, userId);
    if (error === 404) return res.status(404).json({ message: message || 'Note not found' });
    if (error === 403) return res.status(403).json({ message: 'Access denied' });

    const attachments = await Attachment.find({ noteId })
      .sort({ createdAt: 1 })
      .populate('uploadedBy', 'name email _id');

    return res.json(attachments);
  } catch (error) {
    console.error('getAttachments error:', error);
    return res.status(500).json({ message: 'Error fetching attachments', error: error.message });
  }
};

/**
 * GET /api/attachments/:attachmentId/file
 * Streams the file from GridFS. Auth + note access verified on every request.
 * Prevents public URL guessing / revoked-access bypass.
 */
export const serveAttachment = async (req, res) => {
  try {
    const { attachmentId } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(attachmentId)) {
      return res.status(404).json({ message: 'Attachment not found' });
    }

    const attachment = await Attachment.findById(attachmentId);
    if (!attachment) return res.status(404).json({ message: 'Attachment not found' });

    // Verify the requesting user still has access to the parent note
    const { error } = await getNoteWithAccess(String(attachment.noteId), userId);
    if (error === 404) return res.status(404).json({ message: 'Note not found' });
    if (error === 403) return res.status(403).json({ message: 'Access denied' });

    const bucket = getGridFSBucket();

    // Confirm file exists in GridFS before streaming
    const files = await bucket.find({ _id: attachment.gridfsId }).toArray();
    if (!files || files.length === 0) {
      return res.status(404).json({ message: 'File not found in storage' });
    }

    res.set('Content-Type', attachment.mimeType);
    res.set(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(attachment.originalName)}"`
    );
    res.set('Content-Length', attachment.fileSize);
    res.set('Cache-Control', 'private, max-age=3600');

    const downloadStream = bucket.openDownloadStream(attachment.gridfsId);

    downloadStream.on('error', (err) => {
      console.error('GridFS download stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ message: 'Error streaming file' });
      }
    });

    downloadStream.pipe(res);
  } catch (error) {
    console.error('serveAttachment error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Error serving attachment', error: error.message });
    }
  }
};

/**
 * DELETE /api/attachments/:attachmentId
 * Permissions: owner or editor.
 * Removes from GridFS and deletes metadata record.
 */
export const deleteAttachment = async (req, res) => {
  try {
    const { attachmentId } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(attachmentId)) {
      return res.status(404).json({ message: 'Attachment not found' });
    }

    const attachment = await Attachment.findById(attachmentId);
    if (!attachment) return res.status(404).json({ message: 'Attachment not found' });

    // Permission check against parent note
    const { permission, error } = await getNoteWithAccess(
      String(attachment.noteId),
      userId
    );
    if (error === 404) return res.status(404).json({ message: 'Note not found' });
    if (error === 403) return res.status(403).json({ message: 'Access denied' });

    if (permission === 'viewer') {
      return res.status(403).json({ message: 'Viewers cannot delete attachments' });
    }

    const noteId = String(attachment.noteId);
    const gridfsId = attachment.gridfsId;

    // Delete from GridFS
    try {
      const bucket = getGridFSBucket();
      await bucket.delete(gridfsId);
    } catch (gridfsErr) {
      // File may already be missing — log but don't block the metadata cleanup
      console.error('GridFS delete warning (file may already be gone):', gridfsErr.message);
    }

    // Delete metadata record
    await attachment.deleteOne();

    // Broadcast to note room (real-time)
    const io = getIO();
    if (io) {
      io.to(`note:${noteId}`).emit('attachment-deleted', { attachmentId, noteId });
    }

    return res.json({ message: 'Attachment deleted', attachmentId });
  } catch (error) {
    console.error('deleteAttachment error:', error);
    return res.status(500).json({ message: 'Error deleting attachment', error: error.message });
  }
};

// ─── Utility: bulk cleanup for note deletion ──────────────────────────────────

/**
 * Delete all GridFS files and Attachment records for a note.
 * Called when a note is permanently deleted or emptyTrash runs.
 *
 * @param {string|ObjectId} noteId
 */
export const deleteAttachmentsForNote = async (noteId) => {
  try {
    const attachments = await Attachment.find({ noteId });
    if (attachments.length === 0) return;

    const bucket = getGridFSBucket();

    // Best-effort deletion of each GridFS file; don't fail the whole operation if one is missing
    await Promise.allSettled(
      attachments.map(async (att) => {
        try {
          await bucket.delete(att.gridfsId);
        } catch (e) {
          console.error(`GridFS delete error for file ${att.gridfsId}:`, e.message);
        }
      })
    );

    await Attachment.deleteMany({ noteId });
    console.log(`Cleaned up ${attachments.length} attachment(s) for note ${noteId}`);
  } catch (error) {
    console.error('deleteAttachmentsForNote error:', error);
    // Do not re-throw — caller (note delete) should not fail because of attachment cleanup
  }
};
