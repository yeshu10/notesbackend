import mongoose from 'mongoose';
import Comment from '../models/Comment.js';
import Note from '../models/Note.js';
import { getIO, notifyCollaborators } from '../socket/handler.js';

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

// Helper to check user access to a note
const getNoteAccess = async (noteId, userId) => {
  if (!mongoose.Types.ObjectId.isValid(noteId)) {
    return { notFound: true };
  }

  const note = await Note.findById(noteId)
    .populate('createdBy', 'name email _id')
    .populate('collaborators.userId', 'name email _id');

  if (!note) {
    return { notFound: true };
  }

  const isOwner = safeIdEquals(note.createdBy, userId);
  const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));
  const isEditor = isOwner || (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor'));
  const isViewer = collaborator && (collaborator.permission === 'read' || collaborator.permission === 'viewer');
  const hasAccess = isOwner || isEditor || isViewer;

  return { note, isOwner, isEditor, isViewer, hasAccess };
};

// GET /api/notes/:noteId/comments
export const getNoteComments = async (req, res) => {
  try {
    const { noteId } = req.params;
    const userId = req.user._id;

    const access = await getNoteAccess(noteId, userId);
    if (access.notFound) {
      return res.status(404).json({ message: 'Note not found' });
    }

    if (!access.hasAccess) {
      return res.status(403).json({ message: 'Access denied to note comments' });
    }

    const comments = await Comment.find({ noteId })
      .sort({ createdAt: 1 })
      .populate('userId', 'name email _id');

    // Format comments for response, redacting content of deleted comments while preserving reply thread
    const processedComments = comments.map(c => {
      const obj = c.toObject();
      const isAuthor = safeIdEquals(c.userId, userId);
      obj.isAuthor = isAuthor;
      obj.canEdit = !c.isDeleted && isAuthor;
      obj.canDelete = !c.isDeleted && (isAuthor || access.isOwner);

      if (obj.isDeleted) {
        obj.content = '[This comment has been deleted]';
      }
      return obj;
    });

    res.json({ comments: processedComments, totalComments: processedComments.filter(c => !c.isDeleted).length });
  } catch (error) {
    console.error('Get note comments error:', error);
    res.status(500).json({ message: 'Error fetching comments', error: error.message });
  }
};

// POST /api/notes/:noteId/comments
export const addComment = async (req, res) => {
  try {
    const { noteId } = req.params;
    const { content, parentCommentId } = req.body;
    const userId = req.user._id;

    const access = await getNoteAccess(noteId, userId);
    if (access.notFound) {
      return res.status(404).json({ message: 'Note not found' });
    }

    if (!access.hasAccess) {
      return res.status(403).json({ message: 'Access denied. You cannot comment on this note.' });
    }

    // Viewers cannot comment (reading permissions only)
    if (!access.isOwner && !access.isEditor) {
      return res.status(403).json({ message: 'Viewing permission only. Only owners and editors can add comments.' });
    }

    // Trashed notes cannot receive new comments
    if (access.note.isTrashed) {
      return res.status(400).json({ message: 'Cannot comment on a note that is in Trash. Restore it first.' });
    }

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ message: 'Comment content cannot be empty' });
    }

    let parentComment = null;
    if (parentCommentId) {
      if (!mongoose.Types.ObjectId.isValid(parentCommentId)) {
        return res.status(400).json({ message: 'Invalid parent comment ID' });
      }

      parentComment = await Comment.findOne({ _id: parentCommentId, noteId });
      if (!parentComment) {
        return res.status(400).json({ message: 'Parent comment not found on this note' });
      }
    }

    const comment = new Comment({
      noteId,
      userId,
      content: content.trim(),
      parentCommentId: parentComment ? parentComment._id : null
    });

    await comment.save();
    await comment.populate('userId', 'name email _id');

    const commentObj = comment.toObject();
    commentObj.isAuthor = true;
    commentObj.canEdit = true;
    commentObj.canDelete = true;

    // Real-time broadcast to all clients viewing this note
    const io = getIO();
    if (io) {
      io.to(`note:${noteId}`).emit('comment-added', commentObj);
    }

    // Notifications
    const snippet = content.trim().length > 50 ? content.trim().substring(0, 47) + '...' : content.trim();
    if (parentComment) {
      // If replying, notify the parent comment author (if not self)
      if (!safeIdEquals(parentComment.userId, userId)) {
        await notifyCollaborators(
          noteId,
          `${req.user.name} replied to your comment on "${access.note.title}": "${snippet}"`,
          userId,
          'COMMENT_REPLY',
          [parentComment.userId]
        );
      }
      // Also notify note owner if owner is neither replier nor parent author
      if (!safeIdEquals(access.note.createdBy, userId) && !safeIdEquals(access.note.createdBy, parentComment.userId)) {
        await notifyCollaborators(
          noteId,
          `${req.user.name} commented on "${access.note.title}": "${snippet}"`,
          userId,
          'NOTE_COMMENT',
          [access.note.createdBy]
        );
      }
    } else {
      // Top-level comment: notify note collaborators
      await notifyCollaborators(
        noteId,
        `${req.user.name} commented on "${access.note.title}": "${snippet}"`,
        userId,
        'NOTE_COMMENT'
      );
    }

    res.status(201).json(commentObj);
  } catch (error) {
    console.error('Add comment error:', error);
    res.status(500).json({ message: 'Error adding comment', error: error.message });
  }
};

// PATCH /api/comments/:id or /api/notes/:noteId/comments/:id
export const updateComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    const comment = await Comment.findById(id);
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    if (comment.isDeleted) {
      return res.status(400).json({ message: 'Cannot edit a deleted comment' });
    }

    // Check author ownership
    if (!safeIdEquals(comment.userId, userId)) {
      return res.status(403).json({ message: 'You can only edit your own comments' });
    }

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ message: 'Comment content cannot be empty' });
    }

    comment.content = content.trim();
    comment.isEdited = true;
    comment.editedAt = new Date();

    await comment.save();
    await comment.populate('userId', 'name email _id');

    const commentObj = comment.toObject();
    commentObj.isAuthor = true;
    commentObj.canEdit = true;
    commentObj.canDelete = true;

    // Real-time broadcast
    const io = getIO();
    if (io) {
      io.to(`note:${comment.noteId}`).emit('comment-updated', commentObj);
    }

    res.json(commentObj);
  } catch (error) {
    console.error('Update comment error:', error);
    res.status(500).json({ message: 'Error updating comment', error: error.message });
  }
};

// DELETE /api/comments/:id or /api/notes/:noteId/comments/:id
export const deleteComment = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    const comment = await Comment.findById(id);
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    const note = await Note.findById(comment.noteId);
    if (!note) {
      return res.status(404).json({ message: 'Associated note not found' });
    }

    const isAuthor = safeIdEquals(comment.userId, userId);
    const isNoteOwner = safeIdEquals(note.createdBy, userId);

    if (!isAuthor && !isNoteOwner) {
      return res.status(403).json({ message: 'You do not have permission to delete this comment' });
    }

    comment.isDeleted = true;
    comment.deletedAt = new Date();

    await comment.save();
    await comment.populate('userId', 'name email _id');

    const commentObj = comment.toObject();
    commentObj.content = '[This comment has been deleted]';
    commentObj.isAuthor = isAuthor;
    commentObj.canEdit = false;
    commentObj.canDelete = false;

    // Real-time broadcast
    const io = getIO();
    if (io) {
      io.to(`note:${comment.noteId}`).emit('comment-deleted', {
        commentId: comment._id,
        noteId: comment.noteId,
        comment: commentObj
      });
    }

    res.json({
      message: 'Comment deleted',
      commentId: comment._id,
      isDeleted: true,
      comment: commentObj
    });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ message: 'Error deleting comment', error: error.message });
  }
};
