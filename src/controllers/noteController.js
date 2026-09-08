import Note from '../models/Note.js';
import NoteVersion from '../models/NoteVersion.js';
import Reminder from '../models/Reminder.js';
import User from '../models/User.js';
import Comment from '../models/Comment.js';
import mongoose from 'mongoose';
import { notifyCollaborators, saveNoteVersionAndNotify, getIO } from '../socket/handler.js';
import { deleteAttachmentsForNote } from './attachmentController.js';

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

// Get notes with advanced filtering, tag selection, search, sorting and pagination
export const getNotes = async (req, res) => {
  try {
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const filter = req.query.filter || 'all'; // 'all', 'mine', 'shared', 'pinned', 'archived', 'trash', 'favorites'
    const tag = req.query.tag || '';
    const search = req.query.search || '';
    const sort = req.query.sort || 'updated'; // 'updated', 'created', 'title', 'title-desc'

    // Build Mongo Query
    const query = {};

    // 1. Ownership & Access Base Filter
    if (filter === 'mine') {
      query.createdBy = userId;
      query.isTrashed = false;
      query.isArchived = false;
    } else if (filter === 'shared') {
      query['collaborators.userId'] = userId;
      query.createdBy = { $ne: userId };
      query.isTrashed = false;
      query.isArchived = false;
    } else if (filter === 'pinned') {
      query.$or = [{ createdBy: userId }, { 'collaborators.userId': userId }];
      query.isPinned = true;
      query.isTrashed = false;
      query.isArchived = false;
    } else if (filter === 'archived') {
      query.$or = [{ createdBy: userId }, { 'collaborators.userId': userId }];
      query.isArchived = true;
      query.isTrashed = false;
    } else if (filter === 'trash') {
      query.$or = [{ createdBy: userId }, { 'collaborators.userId': userId }];
      query.isTrashed = true;
      query.isArchived = false;
    } else if (filter === 'favorites' || filter === 'saved') {
      query.$or = [{ createdBy: userId }, { 'collaborators.userId': userId }];
      query.isFavorite = true;
      query.isTrashed = false;
      query.isArchived = false;
    } else if (filter === 'reminders') {
      const activeReminders = await Reminder.find({
        userId,
        isActive: true,
        isTriggered: false,
        reminderAt: { $gt: new Date() }
      }).select('noteId');

      const reminderNoteIds = activeReminders.map(r => r.noteId);
      query._id = { $in: reminderNoteIds };
      query.isTrashed = false;
      query.isArchived = false;
    } else {
      // 'all' default - active notes (not trashed, not archived)
      query.$or = [{ createdBy: userId }, { 'collaborators.userId': userId }];
      query.isTrashed = false;
      query.isArchived = false;
    }

    // 2. Tag Filter
    if (tag && tag.trim()) {
      const escapedTag = tag.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.tags = new RegExp(`^${escapedTag}$`, 'i');
    }

    // 3. Search Term
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { title: searchRegex },
          { content: searchRegex },
          { tags: searchRegex },
          { 'checklistItems.text': searchRegex }
        ]
      });
    }

    // 4. Sorting Options
    let sortOption = { lastUpdated: -1 };
    if (sort === 'created') {
      sortOption = { createdAt: -1 };
    } else if (sort === 'title') {
      sortOption = { title: 1 };
    } else if (sort === 'title-desc') {
      sortOption = { title: -1 };
    } else {
      // Default: Pinned first, then lastUpdated descending
      sortOption = { isPinned: -1, lastUpdated: -1 };
    }

    const totalNotes = await Note.countDocuments(query);
    const totalPages = Math.ceil(totalNotes / limit) || 1;
    const skip = (page - 1) * limit;

    const notes = await Note.find(query)
      .sort(sortOption)
      .skip(skip)
      .limit(limit)
      .populate('createdBy', 'name email _id')
      .populate('collaborators.userId', 'name email _id');

    // Attach comment counts and permission info helper for each note
    const noteIds = notes.map(n => n._id);
    const commentCounts = await Comment.aggregate([
      { $match: { noteId: { $in: noteIds }, isDeleted: false } },
      { $group: { _id: '$noteId', count: { $sum: 1 } } }
    ]);
    const commentCountMap = {};
    commentCounts.forEach(c => {
      commentCountMap[String(c._id)] = c.count;
    });

    const processedNotes = notes.map(note => {
      const noteObj = note.toObject();
      const isCreator = safeIdEquals(note.createdBy, userId);
      const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));

      noteObj.isOwnedByCurrentUser = isCreator;
      noteObj.userPermission = isCreator
        ? 'owner'
        : (collaborator ? (collaborator.permission === 'write' || collaborator.permission === 'editor' ? 'editor' : 'viewer') : 'viewer');
      noteObj.commentCount = commentCountMap[String(note._id)] || 0;

      return noteObj;
    });

    res.json({
      notes: processedNotes,
      pagination: {
        currentPage: page,
        totalPages,
        totalNotes,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      }
    });
  } catch (error) {
    console.error(`Get notes error for user ${req.user?._id}:`, error);
    res.status(500).json({ message: 'Error fetching notes', error: error.message });
  }
};

// Get single note by ID
export const getNote = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const note = await Note.findById(req.params.id)
      .populate('createdBy', 'name email _id')
      .populate('collaborators.userId', 'name email _id');

    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const userId = req.user._id;
    const isCreator = safeIdEquals(note.createdBy, userId);
    const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));
    const hasAccess = isCreator || collaborator;

    if (!hasAccess) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const responseNote = note.toObject();
    responseNote.isOwnedByCurrentUser = isCreator;

    // Map permission to owner / editor / viewer
    if (isCreator) {
      responseNote.userPermission = 'owner';
    } else if (collaborator) {
      responseNote.userPermission = (collaborator.permission === 'write' || collaborator.permission === 'editor') ? 'editor' : 'viewer';
    } else {
      responseNote.userPermission = 'viewer';
    }

    const activeCommentCount = await Comment.countDocuments({ noteId: note._id, isDeleted: false });
    responseNote.commentCount = activeCommentCount;

    res.json(responseNote);
  } catch (error) {
    console.error('Get note error:', error);
    res.status(500).json({ message: 'Error fetching note', error: error.message });
  }
};

// Create a new note
export const createNote = async (req, res) => {
  try {
    const { title, type, content, checklistItems, tags, color, isPinned } = req.body;

    const formattedTags = Array.isArray(tags)
      ? tags.map(t => String(t).trim()).filter(Boolean)
      : [];

    const formattedChecklistItems = Array.isArray(checklistItems)
      ? checklistItems.map((item, idx) => ({
        id: item.id || `item-${Date.now()}-${idx}`,
        text: item.text || '',
        completed: !!item.completed
      }))
      : [];

    const note = new Note({
      title: title || 'Untitled Note',
      type: type === 'checklist' ? 'checklist' : 'text',
      content: content || '',
      checklistItems: formattedChecklistItems,
      tags: formattedTags,
      color: color || 'default',
      isPinned: !!isPinned,
      isArchived: false,
      isTrashed: false,
      createdBy: req.user._id
    });

    await note.save();
    await note.populate('createdBy', 'name email _id');

    const responseNote = note.toObject();
    responseNote.isOwnedByCurrentUser = true;
    responseNote.userPermission = 'owner';

    res.status(201).json(responseNote);
  } catch (error) {
    console.error('Create note error:', error);
    res.status(500).json({ message: 'Error creating note', error: error.message });
  }
};

// Update an existing note
export const updateNote = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const note = await Note.findById(req.params.id)
      .populate('createdBy', 'name email _id')
      .populate('collaborators.userId', 'name email _id');

    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const userId = req.user._id;
    const isCreator = safeIdEquals(note.createdBy, userId);
    const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));

    const canWrite = isCreator ||
      (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor'));

    if (!canWrite) {
      return res.status(403).json({ message: 'Write access denied. You only have viewing permissions.' });
    }

    const { title, type, content, checklistItems, tags, color, isPinned, isFavorite, isArchived, isTrashed, forceNewVersion, sessionId } = req.body;

    // Forbid editing or archiving trashed notes unless explicitly restoring (isTrashed: false)
    if (note.isTrashed && isTrashed !== false) {
      return res.status(400).json({ message: 'Cannot edit or archive a note that is in Trash. Restore it first.' });
    }

    const newTitle = title !== undefined ? title.trim() || 'Untitled Note' : note.title;
    const newContent = content !== undefined ? content : note.content;
    const newType = type !== undefined ? type : (note.type || 'text');
    const newChecklistItems = checklistItems !== undefined ? checklistItems.map((item, idx) => ({
      id: item.id || `item-${Date.now()}-${idx}`,
      text: item.text || '',
      completed: !!item.completed
    })) : note.checklistItems;

    const isChecklistChanged = checklistItems !== undefined && JSON.stringify(note.checklistItems) !== JSON.stringify(newChecklistItems);
    const hasChanged = (newTitle !== note.title) || (newContent !== note.content) || (newType !== note.type) || isChecklistChanged;

    const updateFields = {};
    if (title !== undefined) updateFields.title = newTitle;
    if (content !== undefined) updateFields.content = newContent;
    if (type !== undefined) updateFields.type = newType;
    if (checklistItems !== undefined) updateFields.checklistItems = newChecklistItems;
    if (tags !== undefined && Array.isArray(tags)) {
      updateFields.tags = tags.map(t => String(t).trim()).filter(Boolean);
    }
    if (color !== undefined) updateFields.color = color;
    if (isPinned !== undefined) updateFields.isPinned = isPinned;
    if (isFavorite !== undefined) updateFields.isFavorite = isFavorite;

    if (isArchived !== undefined) {
      const boolArchived = Boolean(isArchived);
      if (boolArchived) {
        if (note.isTrashed) {
          return res.status(400).json({ message: 'Cannot archive a note that is in Trash. Restore it first.' });
        }
        updateFields.isArchived = true;
        updateFields.archivedAt = new Date();
        updateFields.isTrashed = false;
        updateFields.trashedAt = null;
      } else {
        updateFields.isArchived = false;
        updateFields.archivedAt = null;
      }
    }

    if (isTrashed !== undefined) {
      const boolTrashed = Boolean(isTrashed);
      if (boolTrashed) {
        updateFields.isTrashed = true;
        updateFields.trashedAt = new Date();
        updateFields.isArchived = false;
        updateFields.archivedAt = null;
      } else {
        updateFields.isTrashed = false;
        updateFields.trashedAt = null;
      }
    }

    updateFields.lastUpdated = new Date();

    const updatedNote = await Note.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true }
    )
      .populate('createdBy', 'name email _id')
      .populate('collaborators.userId', 'name email _id');

    // Save version snapshot and notify collaborators only if content/checklist changed
    if (hasChanged) {
      await saveNoteVersionAndNotify({
        noteId: updatedNote._id,
        title: updatedNote.title,
        content: updatedNote.content,
        type: updatedNote.type,
        checklistItems: updatedNote.checklistItems,
        userId,
        userName: req.user.name,
        changeType: 'updated',
        forceNewVersion: !!forceNewVersion,
        sessionId
      });

      // Broadcast update to real-time room subscribers if io is initialized
      const io = getIO();
      if (io) {
        io.to(`note:${updatedNote._id}`).emit('note-updated', {
          _id: updatedNote._id,
          content: updatedNote.content,
          title: updatedNote.title,
          type: updatedNote.type,
          checklistItems: updatedNote.checklistItems,
          tags: updatedNote.tags,
          lastUpdated: updatedNote.lastUpdated,
          updatedBy: {
            id: userId.toString(),
            name: req.user.name
          }
        });
      }
    }

    const responseNote = updatedNote.toObject();
    responseNote.isOwnedByCurrentUser = isCreator;
    responseNote.userPermission = isCreator ? 'owner' : (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor') ? 'editor' : 'viewer');

    res.json(responseNote);
  } catch (error) {
    console.error('Update note error:', error);
    res.status(500).json({ message: 'Error updating note', error: error.message });
  }
};

// Delete note (Soft delete to Trash if active; Permanent delete if already in Trash)
export const deleteNote = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const note = await Note.findById(req.params.id);
    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const userId = req.user._id;
    if (!safeIdEquals(note.createdBy, userId)) {
      return res.status(403).json({ message: 'Only the note owner can delete this note' });
    }

    // If note is not yet in trash, move to trash (soft delete)
    if (!note.isTrashed) {
      note.isTrashed = true;
      note.trashedAt = new Date();
      // Moving to trash removes it from active and archive states
      note.isArchived = false;
      note.archivedAt = null;
      await note.save();
      await Reminder.updateMany({ noteId: req.params.id }, { isActive: false });
      await note.populate('createdBy', 'name email _id');
      await note.populate('collaborators.userId', 'name email _id');
      const resObj = note.toObject();
      resObj.isOwnedByCurrentUser = true;
      resObj.userPermission = 'owner';
      return res.json({ message: 'Note moved to trash', softDeleted: true, noteId: note._id, note: resObj });
    }

    // If note is already in trash, delete permanently
    await Reminder.deleteMany({ noteId: req.params.id });
    await deleteAttachmentsForNote(req.params.id);
    await note.deleteOne();
    res.json({ message: 'Note permanently deleted', softDeleted: false, noteId: req.params.id });
  } catch (error) {
    console.error('Delete note error:', error);
    res.status(500).json({ message: 'Error deleting note', error: error.message });
  }
};

// Restore note from trash
export const restoreNote = async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const userId = req.user._id;
    const isCreator = safeIdEquals(note.createdBy, userId);
    const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));

    if (!isCreator && !collaborator) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Restoring from trash returns the note to active state (not archived, not trashed)
    note.isTrashed = false;
    note.trashedAt = null;
    note.isArchived = false;
    note.archivedAt = null;
    note.lastUpdated = new Date();

    await note.save();
    await Reminder.updateMany(
      { noteId: req.params.id, reminderAt: { $gt: new Date() } },
      { isActive: true, isTriggered: false }
    );
    await note.populate('createdBy', 'name email _id');
    await note.populate('collaborators.userId', 'name email _id');

    const resObj = note.toObject();
    resObj.isOwnedByCurrentUser = isCreator;
    resObj.userPermission = isCreator ? 'owner' : (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor') ? 'editor' : 'viewer');

    res.json(resObj);
  } catch (error) {
    console.error('Restore note error:', error);
    res.status(500).json({ message: 'Error restoring note', error: error.message });
  }
};

// Archive note
export const archiveNote = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const note = await Note.findById(req.params.id);
    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const userId = req.user._id;
    const isCreator = safeIdEquals(note.createdBy, userId);
    const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));
    const canWrite = isCreator || (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor'));

    if (!canWrite) {
      return res.status(403).json({ message: 'Write access denied. You only have viewing permissions.' });
    }

    if (note.isTrashed) {
      return res.status(400).json({ message: 'Cannot archive a note that is in Trash. Restore it first.' });
    }

    note.isArchived = true;
    note.archivedAt = new Date();
    note.isTrashed = false;
    note.trashedAt = null;
    note.lastUpdated = new Date();

    await note.save();
    await note.populate('createdBy', 'name email _id');
    await note.populate('collaborators.userId', 'name email _id');

    const resObj = note.toObject();
    resObj.isOwnedByCurrentUser = isCreator;
    resObj.userPermission = isCreator ? 'owner' : (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor') ? 'editor' : 'viewer');

    res.json(resObj);
  } catch (error) {
    console.error('Archive note error:', error);
    res.status(500).json({ message: 'Error archiving note', error: error.message });
  }
};

// Unarchive note
export const unarchiveNote = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const note = await Note.findById(req.params.id);
    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const userId = req.user._id;
    const isCreator = safeIdEquals(note.createdBy, userId);
    const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));
    const canWrite = isCreator || (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor'));

    if (!canWrite) {
      return res.status(403).json({ message: 'Write access denied. You only have viewing permissions.' });
    }

    note.isArchived = false;
    note.archivedAt = null;
    note.isTrashed = false;
    note.trashedAt = null;
    note.lastUpdated = new Date();

    await note.save();
    await note.populate('createdBy', 'name email _id');
    await note.populate('collaborators.userId', 'name email _id');

    const resObj = note.toObject();
    resObj.isOwnedByCurrentUser = isCreator;
    resObj.userPermission = isCreator ? 'owner' : (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor') ? 'editor' : 'viewer');

    res.json(resObj);
  } catch (error) {
    console.error('Unarchive note error:', error);
    res.status(500).json({ message: 'Error unarchiving note', error: error.message });
  }
};

// Empty trash (permanently remove all trashed notes created by current user)
export const emptyTrash = async (req, res) => {
  try {
    const userId = req.user._id;
    // Find the notes that will be deleted so we can clean up their attachments
    const notesToDelete = await Note.find({ createdBy: userId, isTrashed: true }).select('_id');
    const noteIds = notesToDelete.map(n => n._id);

    // Clean up attachments for every trashed note (best-effort, non-blocking)
    await Promise.allSettled(noteIds.map(id => deleteAttachmentsForNote(id)));

    const result = await Note.deleteMany({
      createdBy: userId,
      isTrashed: true
    });

    res.json({ message: `Trash emptied. ${result.deletedCount} notes deleted permanently.` });
  } catch (error) {
    console.error('Empty trash error:', error);
    res.status(500).json({ message: 'Error emptying trash', error: error.message });
  }
};

// Share note with a user
export const shareNote = async (req, res) => {
  try {
    const { email, permission } = req.body; // permission: 'editor' | 'viewer' | 'write' | 'read'

    // Normalize permission to 'write' or 'read' for internal schema while returning friendly names
    const normalizedPerm = (permission === 'editor' || permission === 'write') ? 'write' : 'read';
    const readablePermName = normalizedPerm === 'write' ? 'Editor' : 'Viewer';

    const note = await Note.findById(req.params.id)
      .populate('createdBy', 'name email _id')
      .populate('collaborators.userId', 'name email _id');

    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    // Only owner can share
    if (!note.createdBy._id.equals(req.user._id)) {
      return res.status(403).json({ message: 'Only the note owner can manage access permissions' });
    }

    // Cannot share with yourself
    if (email.toLowerCase().trim() === req.user.email.toLowerCase().trim()) {
      return res.status(400).json({ message: 'You are already the owner of this note' });
    }

    const collaborator = await User.findOne({ email: email.toLowerCase().trim() });
    if (!collaborator) {
      return res.status(404).json({ message: `User with email "${email}" was not found` });
    }

    const existingIndex = note.collaborators.findIndex(c =>
      c.userId && c.userId._id.equals(collaborator._id)
    );

    let notifMessage = '';
    let notifType = 'NOTE_SHARED';

    if (existingIndex !== -1) {
      const oldPerm = (note.collaborators[existingIndex].permission === 'write' || note.collaborators[existingIndex].permission === 'editor') ? 'Editor' : 'Viewer';
      note.collaborators[existingIndex].permission = normalizedPerm;
      notifMessage = `Your access to "${note.title}" was changed from ${oldPerm} to ${readablePermName}.`;
      notifType = 'PERMISSION_CHANGED';
    } else {
      note.collaborators.push({
        userId: collaborator._id,
        permission: normalizedPerm
      });
      notifMessage = `${req.user.name} shared "${note.title}" with you (${readablePermName} access).`;
      notifType = 'NOTE_SHARED';
    }

    await note.save();
    await note.populate('createdBy', 'name email _id');
    await note.populate('collaborators.userId', 'name email _id');

    notifyCollaborators(
      note._id,
      notifMessage,
      req.user._id,
      notifType,
      [collaborator._id]
    );

    const responseNote = note.toObject();
    responseNote.isOwnedByCurrentUser = true;
    responseNote.userPermission = 'owner';

    res.json(responseNote);
  } catch (error) {
    console.error('Share note error:', error);
    res.status(500).json({ message: 'Error sharing note', error: error.message });
  }
};

// Remove collaborator access from a note
export const removeCollaborator = async (req, res) => {
  try {
    const { collaboratorId } = req.params;

    const note = await Note.findById(req.params.id);
    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    // Only owner can remove access
    if (!note.createdBy.equals(req.user._id)) {
      return res.status(403).json({ message: 'Only the owner can remove collaborators' });
    }

    note.collaborators = note.collaborators.filter(c =>
      c.userId && !c.userId.equals(collaboratorId)
    );

    await note.save();
    await note.populate('createdBy', 'name email _id');
    await note.populate('collaborators.userId', 'name email _id');

    res.json(note);
  } catch (error) {
    console.error('Remove collaborator error:', error);
    res.status(500).json({ message: 'Error removing collaborator', error: error.message });
  }
};

// Search users for sharing auto-suggest
export const searchUsers = async (req, res) => {
  try {
    const query = req.query.query || '';
    if (!query || query.length < 2) {
      return res.json({ users: [] });
    }

    const regex = new RegExp(query, 'i');
    const users = await User.find({
      _id: { $ne: req.user._id },
      $or: [{ name: regex }, { email: regex }]
    })
      .select('name email _id')
      .limit(10);

    res.json({ users });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ message: 'Error searching users', error: error.message });
  }
};

// Get all unique user tags across their notes
export const getUserTags = async (req, res) => {
  try {
    const userId = req.user._id;

    // Find all distinct tags in non-trashed notes accessible by the user
    const tags = await Note.distinct('tags', {
      $or: [{ createdBy: userId }, { 'collaborators.userId': userId }],
      isTrashed: false
    });

    // Clean and filter empty values
    const cleanTags = tags.filter(t => Boolean(t) && typeof t === 'string');

    res.json({ tags: cleanTags });
  } catch (error) {
    console.error('Get user tags error:', error);
    res.status(500).json({ message: 'Error fetching tags', error: error.message });
  }
};

// --- VERSION HISTORY CONTROLLERS ---

// Get version history for a note
export const getNoteVersions = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const note = await Note.findById(req.params.id);
    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const userId = req.user._id;
    const isCreator = safeIdEquals(note.createdBy, userId);
    const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));
    const hasAccess = isCreator || collaborator;

    if (!hasAccess) {
      return res.status(403).json({ message: 'Access denied to version history' });
    }

    const versions = await NoteVersion.find({ noteId: req.params.id })
      .sort({ versionNumber: -1 })
      .populate('editedBy', 'name email _id');

    res.json(versions);
  } catch (error) {
    console.error('Get note versions error:', error);
    res.status(500).json({ message: 'Error fetching version history', error: error.message });
  }
};

// Get a specific version details
export const getNoteVersion = async (req, res) => {
  try {
    const { id, versionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(versionId)) {
      return res.status(404).json({ message: 'Version or note not found' });
    }

    const note = await Note.findById(id);
    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const userId = req.user._id;
    const isCreator = safeIdEquals(note.createdBy, userId);
    const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));
    const hasAccess = isCreator || collaborator;

    if (!hasAccess) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const version = await NoteVersion.findOne({ _id: versionId, noteId: id })
      .populate('editedBy', 'name email _id');

    if (!version) {
      return res.status(404).json({ message: 'Version not found' });
    }

    res.json(version);
  } catch (error) {
    console.error('Get note version error:', error);
    res.status(500).json({ message: 'Error fetching version details', error: error.message });
  }
};

// Restore a specific version
export const restoreNoteVersion = async (req, res) => {
  try {
    const { id, versionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(versionId)) {
      return res.status(404).json({ message: 'Version or note not found' });
    }

    const note = await Note.findById(id);
    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    const userId = req.user._id;
    const isCreator = safeIdEquals(note.createdBy, userId);
    const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));

    const canWrite = isCreator ||
      (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor'));

    if (!canWrite) {
      return res.status(403).json({ message: 'Write access denied. Viewers cannot restore versions.' });
    }

    const targetVersion = await NoteVersion.findOne({ _id: versionId, noteId: id });
    if (!targetVersion) {
      return res.status(404).json({ message: 'Version to restore not found' });
    }

    // 1. Update current note content, title, type, and checklistItems
    note.title = targetVersion.title || 'Untitled Note';
    note.content = targetVersion.content || '';
    note.type = targetVersion.type || 'text';
    note.checklistItems = targetVersion.checklistItems || [];
    note.lastUpdated = new Date();
    await note.save();

    // 2. Create a new version entry preserving the history
    const versionCount = await NoteVersion.countDocuments({ noteId: id });
    const restoredVersion = await NoteVersion.create({
      noteId: id,
      title: note.title,
      content: note.content,
      type: note.type,
      checklistItems: note.checklistItems,
      editedBy: userId,
      versionNumber: versionCount + 1,
      changeType: 'restored'
    });

    await note.populate('createdBy', 'name email _id');
    await note.populate('collaborators.userId', 'name email _id');

    // Notify collaborators
    notifyCollaborators(
      id,
      `${req.user.name} restored a previous version of "${note.title}"`,
      userId,
      'NOTE_RESTORED'
    );

    // Broadcast restored note to connected room subscribers in real-time
    const io = getIO();
    if (io) {
      io.to(`note:${id}`).emit('note-updated', {
        _id: id,
        content: note.content,
        title: note.title,
        type: note.type,
        checklistItems: note.checklistItems,
        tags: note.tags,
        lastUpdated: note.lastUpdated,
        updatedBy: {
          id: userId.toString(),
          name: req.user.name
        }
      });
    }

    const responseNote = note.toObject();
    responseNote.isOwnedByCurrentUser = isCreator;
    responseNote.userPermission = isCreator ? 'owner' : 'editor';
    responseNote.restoredVersion = restoredVersion;

    res.json(responseNote);
  } catch (error) {
    console.error('Restore note version error:', error);
    res.status(500).json({ message: 'Error restoring version', error: error.message });
  }
};