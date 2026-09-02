import Note from '../models/Note.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import { notifyCollaborators } from '../socket/handler.js';

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
    } else if (filter === 'favorites' || filter === 'saved') {
      query.$or = [{ createdBy: userId }, { 'collaborators.userId': userId }];
      query.isFavorite = true;
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
          { tags: searchRegex }
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

    // Attach permission info helper for each note
    const processedNotes = notes.map(note => {
      const noteObj = note.toObject();
      const isCreator = safeIdEquals(note.createdBy, userId);
      const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, userId));

      noteObj.isOwnedByCurrentUser = isCreator;
      noteObj.userPermission = isCreator
        ? 'owner'
        : (collaborator ? (collaborator.permission === 'write' || collaborator.permission === 'editor' ? 'editor' : 'viewer') : 'viewer');

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

    res.json(responseNote);
  } catch (error) {
    console.error('Get note error:', error);
    res.status(500).json({ message: 'Error fetching note', error: error.message });
  }
};

// Create a new note
export const createNote = async (req, res) => {
  try {
    const { title, content, tags, color, isPinned } = req.body;

    const formattedTags = Array.isArray(tags)
      ? tags.map(t => String(t).trim()).filter(Boolean)
      : [];

    const note = new Note({
      title: title || 'Untitled Note',
      content: content || '',
      tags: formattedTags,
      color: color || 'default',
      isPinned: !!isPinned,
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

    const { title, content, tags, color, isPinned, isFavorite, isArchived, isTrashed } = req.body;

    const updateFields = {};
    if (title !== undefined) updateFields.title = title.trim() || 'Untitled Note';
    if (content !== undefined) updateFields.content = content;
    if (tags !== undefined && Array.isArray(tags)) {
      updateFields.tags = tags.map(t => String(t).trim()).filter(Boolean);
    }
    if (color !== undefined) updateFields.color = color;
    if (isPinned !== undefined) updateFields.isPinned = isPinned;
    if (isFavorite !== undefined) updateFields.isFavorite = isFavorite;

    if (isArchived !== undefined) {
      updateFields.isArchived = isArchived;
      if (isArchived) updateFields.archivedAt = new Date();
    }
    if (isTrashed !== undefined) {
      updateFields.isTrashed = isTrashed;
      if (isTrashed) updateFields.trashedAt = new Date();
    }

    updateFields.lastUpdated = new Date();

    const updatedNote = await Note.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true }
    )
      .populate('createdBy', 'name email _id')
      .populate('collaborators.userId', 'name email _id');

    const responseNote = updatedNote.toObject();
    responseNote.isOwnedByCurrentUser = isCreator;
    responseNote.userPermission = isCreator ? 'owner' : (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor') ? 'editor' : 'viewer');

    notifyCollaborators(updatedNote._id, `Note "${updatedNote.title}" was updated by ${req.user.name}`, userId);

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
      await note.save();
      return res.json({ message: 'Note moved to trash', softDeleted: true, noteId: note._id });
    }

    // If note is already in trash, delete permanently
    await note.deleteOne();
    res.json({ message: 'Note permanently deleted', softDeleted: false, noteId: req.params.id });
  } catch (error) {
    console.error('Delete note error:', error);
    res.status(500).json({ message: 'Error deleting note', error: error.message });
  }
};

// Restore note from trash or archive
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

    note.isTrashed = false;
    note.trashedAt = null;
    note.isArchived = false;
    note.archivedAt = null;
    note.lastUpdated = new Date();

    await note.save();
    await note.populate('createdBy', 'name email _id');
    await note.populate('collaborators.userId', 'name email _id');

    res.json(note);
  } catch (error) {
    console.error('Restore note error:', error);
    res.status(500).json({ message: 'Error restoring note', error: error.message });
  }
};

// Empty trash (permanently remove all trashed notes created by current user)
export const emptyTrash = async (req, res) => {
  try {
    const userId = req.user._id;
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

    if (existingIndex !== -1) {
      note.collaborators[existingIndex].permission = normalizedPerm;
    } else {
      note.collaborators.push({
        userId: collaborator._id,
        permission: normalizedPerm
      });
    }

    await note.save();
    await note.populate('createdBy', 'name email _id');
    await note.populate('collaborators.userId', 'name email _id');

    notifyCollaborators(
      note._id,
      `You were given ${normalizedPerm === 'write' ? 'Editor' : 'Viewer'} access to "${note.title}" by ${req.user.name}`,
      req.user._id,
      'share',
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