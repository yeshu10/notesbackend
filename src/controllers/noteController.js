import Note from '../models/Note.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import { notifyCollaborators } from '../socket/handler.js';

// @desc    Get all notes for a user
// @route   GET /api/notes
// @access  Private
export const getNotes = async (req, res) => {
  try {
    const userId = req.user._id;
    const userIdStr = userId.toString();
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const showArchived = req.query.showArchived === 'true';

    console.log(`Notes request from user: ${userId} (${typeof userId}), page: ${page}, limit: ${limit}`);
    console.log(`User ID as string: ${userIdStr} (${typeof userIdStr})`);

    // First, get ALL notes for debugging
    console.log("------ DEBUGGING ALL NOTES IN SYSTEM ------");
    const allNotes = await Note.find({})
      .populate('createdBy', 'name email _id')
      .populate('collaborators.userId', 'name email _id');
    
    console.log(`Total notes in database: ${allNotes.length}`);
    
    // Debug each note
    allNotes.forEach((note, index) => {
      const creatorId = note.createdBy?._id;
      const creatorIdStr = creatorId?.toString();
      
      console.log(`\nNote ${index + 1}: "${note.title}"`);
      console.log(`- Creator ID: ${creatorId} (${typeof creatorId})`);
      console.log(`- Creator ID as string: ${creatorIdStr} (${typeof creatorIdStr})`);
      console.log(`- Is created by current user? ${creatorIdStr === userIdStr ? 'YES' : 'NO'}`);
      
      console.log(`- Collaborators: ${note.collaborators.length}`);
      note.collaborators.forEach((collab, i) => {
        const collabId = collab.userId?._id;
        const collabIdStr = collabId?.toString();
        console.log(`  - Collaborator ${i + 1}: ${collabIdStr} (${typeof collabIdStr})`);
        console.log(`  - Is current user? ${collabIdStr === userIdStr ? 'YES' : 'NO'}`);
      });
      
      // Direct comparison test
      const directMatch = note.createdBy._id.toString() === userId.toString();
      const collaboratorMatch = note.collaborators.some(c => 
        c.userId && c.userId._id && c.userId._id.toString() === userId.toString()
      );
      console.log(`- Should show to current user? ${directMatch || collaboratorMatch ? 'YES' : 'NO'}`);
    });

    // Now let's construct an absolutely reliable query
    console.log("\n------ CONSTRUCTING RELIABLE QUERY ------");
    
    // Safer approach: convert all IDs to strings for comparison
    const userNotesFiltered = allNotes.filter(note => {
      // Check if user is the creator
      const isCreator = note.createdBy._id.toString() === userId.toString();
      
      // Check if user is a collaborator
      const isCollaborator = note.collaborators.some(collab => 
        collab.userId && collab.userId._id && 
        collab.userId._id.toString() === userId.toString()
      );
      
      const shouldInclude = (isCreator || isCollaborator) && 
                            (note.isArchived === showArchived);
      
      console.log(`Note "${note.title}": isCreator=${isCreator}, isCollaborator=${isCollaborator}, shouldInclude=${shouldInclude}`);
      
      return shouldInclude;
    });
    
    console.log(`\nFiltered notes count: ${userNotesFiltered.length} of ${allNotes.length}`);
    userNotesFiltered.forEach(note => {
      console.log(`- "${note.title}" (creator: ${note.createdBy.name})`);
    });
    
    // Sort by lastUpdated (newest first)
    userNotesFiltered.sort((a, b) => 
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
    );
    
    // Apply pagination
    const totalNotes = userNotesFiltered.length;
    const totalPages = Math.ceil(totalNotes / limit) || 1;
    const start = (page - 1) * limit;
    const end = Math.min(start + limit, totalNotes);
    const paginatedNotes = userNotesFiltered.slice(start, end);
    
    console.log(`Final notes to return: ${paginatedNotes.length}`);

    res.json({
      notes: paginatedNotes,
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

// @desc    Get single note
// @route   GET /api/notes/:id
// @access  Private
export const getNote = async (req, res) => {
  try {
    const note = await Note.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('collaborators.userId', 'name email');

    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    // Check access permission
    const isCreator = note.createdBy._id.equals(req.user._id);
    const collaborator = note.collaborators.find(c => c.userId._id.equals(req.user._id));
    const hasAccess = isCreator || collaborator;

    if (!hasAccess) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Add explicit permission info to the response
    const responseNote = note.toObject();
    responseNote.isOwnedByCurrentUser = isCreator;
    
    // Determine user's permission level
    responseNote.userPermission = isCreator ? 'write' : (collaborator ? collaborator.permission : 'read');
    
    // Add debug info for troubleshooting
    responseNote.permissionInfo = {
      requestUserId: req.user._id.toString(),
      noteCreatorId: note.createdBy._id.toString(),
      isCreator,
      collaboratorInfo: collaborator ? {
        id: collaborator.userId._id.toString(),
        permission: collaborator.permission
      } : null
    };

    console.log('Sending note with permissions:', {
      noteId: note._id.toString(),
      isCreator,
      userPermission: responseNote.userPermission,
      userId: req.user._id.toString()
    });

    res.json(responseNote);
  } catch (error) {
    console.error('Get note error:', error);
    res.status(500).json({ message: 'Error fetching note', error: error.message });
  }
};

// @desc    Create new note
// @route   POST /api/notes
// @access  Private
export const createNote = async (req, res) => {
  try {
    const { title, content } = req.body;

    const note = new Note({
      title,
      content,
      createdBy: req.user._id
    });

    await note.save();
    await note.populate('createdBy', 'name email');

    // Don't send notification for note creation to the creator
    res.status(201).json(note);
  } catch (error) {
    console.error('Create note error:', error);
    res.status(500).json({ message: 'Error creating note', error: error.message });
  }
};

// @desc    Update note
// @route   PATCH /api/notes/:id
// @access  Private
export const updateNote = async (req, res) => {
  try {
    const note = await Note.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('collaborators.userId', 'name email');

    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    // More explicit permission checks
    const isCreator = note.createdBy._id.equals(req.user._id);
    const collaborator = note.collaborators.find(c => c.userId._id.equals(req.user._id));
    
    // Check write permission
    const canWrite = isCreator || 
      (collaborator && collaborator.permission === 'write');

    // Detailed permission debugging
    console.log('Update permission check:', {
      noteId: note._id.toString(),
      requestUserId: req.user._id.toString(),
      noteCreatorId: note.createdBy._id.toString(),
      isCreator,
      collaboratorInfo: collaborator ? {
        id: collaborator.userId._id.toString(),
        permission: collaborator.permission,
        hasWriteAccess: collaborator.permission === 'write'
      } : null,
      canWrite
    });

    if (!canWrite) {
      return res.status(403).json({ 
        message: 'Write access denied',
        permissionInfo: {
          userRole: isCreator ? 'creator' : 'collaborator',
          userId: req.user._id.toString(),
          noteCreatorId: note.createdBy._id.toString(),
          collaborators: note.collaborators.map(c => ({
            userId: c.userId._id.toString(),
            permission: c.permission
          }))
        }
      });
    }

    const { title, content } = req.body;
    
    // Only update fields that are provided
    const updateFields = {};
    if (title !== undefined) updateFields.title = title;
    if (content !== undefined) updateFields.content = content;
    updateFields.lastUpdated = new Date();

    const updatedNote = await Note.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true }
    )
    .populate('createdBy', 'name email')
    .populate('collaborators.userId', 'name email');

    // Add explicit permission info to the response
    const responseNote = updatedNote.toObject();
    responseNote.isOwnedByCurrentUser = updatedNote.createdBy._id.equals(req.user._id);
    responseNote.userPermission = responseNote.isOwnedByCurrentUser ? 'write' : 
      (collaborator ? collaborator.permission : 'read');

    // Notify collaborators
    notifyCollaborators(updatedNote._id, `Note "${updatedNote.title}" was updated by ${req.user.name}`, req.user._id);

    res.json(responseNote);
  } catch (error) {
    console.error('Update note error:', error);
    res.status(500).json({ 
      message: 'Error updating note', 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

// @desc    Delete note
// @route   DELETE /api/notes/:id
// @access  Private
export const deleteNote = async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    // Only creator can delete
    if (!note.createdBy.equals(req.user._id)) {
      return res.status(403).json({ message: 'Only the creator can delete the note' });
    }

    await note.deleteOne();
    res.json({ message: 'Note deleted successfully' });
  } catch (error) {
    console.error('Delete note error:', error);
    res.status(500).json({ message: 'Error deleting note', error: error.message });
  }
};

// @desc    Share note with other users
// @route   POST /api/notes/:id/share
// @access  Private
export const shareNote = async (req, res) => {
  try {
    const { email, permission } = req.body;
    if (!['read', 'write'].includes(permission)) {
      return res.status(400).json({ message: 'Invalid permission type' });
    }

    const note = await Note.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('collaborators.userId', 'name email');

    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }

    // Only creator can share
    if (!note.createdBy._id.equals(req.user._id)) {
      return res.status(403).json({ message: 'Only the creator can share the note' });
    }

    // Find user to share with
    const collaborator = await User.findOne({ email });
    if (!collaborator) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Debug logging for share operation
    console.log('Share note:', {
      noteId: note._id.toString(),
      creatorId: note.createdBy._id.toString(),
      collaboratorId: collaborator._id.toString(),
      permission,
      existingCollaborators: note.collaborators.map(c => ({
        userId: c.userId._id.toString(),
        permission: c.permission
      }))
    });

    // Check if already shared
    const existingCollaborator = note.collaborators.find(c => 
      c.userId._id.equals(collaborator._id)
    );

    if (existingCollaborator) {
      existingCollaborator.permission = permission;
    } else {
      note.collaborators.push({
        userId: collaborator._id,
        permission
      });
    }

    await note.save();
    
    // Re-populate after save
    await note.populate('createdBy', 'name email');
    await note.populate('collaborators.userId', 'name email');

    // Notify the new collaborator
    notifyCollaborators(
      note._id, 
      `You were given ${permission} access to "${note.title}" by ${req.user.name}`, 
      req.user._id,
      'share',
      [collaborator._id]
    );

    res.json(note);
  } catch (error) {
    console.error('Share note error:', error);
    res.status(500).json({ 
      message: 'Error sharing note', 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}; 