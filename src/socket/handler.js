import jwt from 'jsonwebtoken';
import Note from '../models/Note.js';
import Notification from '../models/Notification.js';

let io;

export const initializeSocket = (socketIo) => {
  io = socketIo;
};

// Helper function to safely compare MongoDB ObjectIDs
const safeIdEquals = (id1, id2) => {
  if (!id1 || !id2) return false;
  try {
    // Try using the equals method first (MongoDB ObjectId)
    if (id1.equals && typeof id1.equals === 'function') {
      return id1.equals(id2);
    }
    // Then try string comparison
    return String(id1) === String(id2);
  } catch (error) {
    console.error('Error comparing IDs:', error);
    // Fallback to string comparison
    return String(id1) === String(id2);
  }
};

export const socketHandler = async (socket) => {
  try {
    // Authenticate socket connection
    const token = socket.handshake.auth.token;
    if (!token) {
      console.log('Socket authentication failed: No token');
      socket.disconnect();
      return;
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    const userId = decoded.userId;

    console.log('Socket connected:', { userId, socketId: socket.id });
    socket.join(`user:${userId}`);

    // Join note room
    socket.on('join-note', async (noteId) => {
      try {
        console.log('Join note request:', { userId, noteId });
        
        const note = await Note.findById(noteId)
          .populate('createdBy', 'name email')
          .populate('collaborators.userId', 'name email');

        if (!note) {
          console.log('Note not found:', noteId);
          return;
        }

        // More reliable access check using helper function
        const isCreator = safeIdEquals(note.createdBy._id, userId);
        const collaborator = note.collaborators.find(c => safeIdEquals(c.userId._id, userId));
        const hasAccess = isCreator || collaborator;

        console.log('Socket room join check:', {
          noteId,
          userId,
          isCreator,
          hasCollaboratorAccess: !!collaborator,
          hasAccess
        });

        if (hasAccess) {
          socket.join(`note:${noteId}`);
          console.log('User joined note room:', { userId, noteId });
        } else {
          console.log('Access denied to note:', { userId, noteId });
        }
      } catch (error) {
        console.error('Error joining note room:', error);
      }
    });

    // Leave note room
    socket.on('leave-note', (noteId) => {
      socket.leave(`note:${noteId}`);
      console.log('User left note room:', { userId, noteId });
    });

    // Handle note updates
    socket.on('note-update', async ({ noteId, content, title }) => {
      try {
        const note = await Note.findById(noteId)
          .populate('createdBy', 'name email')
          .populate('collaborators.userId', 'name email');

        if (!note) {
          console.log('Note not found for update:', noteId);
          return;
        }

        // Check write permission more reliably
        const isCreator = safeIdEquals(note.createdBy._id, userId);
        const collaborator = note.collaborators.find(c => safeIdEquals(c.userId._id, userId));
        const canWrite = isCreator || (collaborator && collaborator.permission === 'write');

        console.log('Socket write check:', {
          noteId,
          userId,
          isCreator,
          collaboratorInfo: collaborator ? {
            id: collaborator.userId._id.toString(),
            permission: collaborator.permission
          } : null,
          canWrite
        });

        if (!canWrite) {
          console.log('Write access denied for real-time update:', { userId, noteId });
          return;
        }

        // Update note in database
        note.content = content;
        if (title) note.title = title;
        note.lastUpdated = new Date();
        await note.save();

        // Broadcast to all users in the note room except sender
        socket.to(`note:${noteId}`).emit('note-updated', {
          _id: noteId,
          content,
          title,
          lastUpdated: note.lastUpdated
        });

        // Notify collaborators about the update (excluding the user who made the change)
        notifyCollaborators(
          noteId, 
          `Note "${note.title}" was updated by ${collaborator ? collaborator.userId.name : note.createdBy.name}`, 
          userId
        );

        console.log('Note updated in real-time:', { noteId, updatedBy: userId });
      } catch (error) {
        console.error('Error updating note in real-time:', error);
      }
    });

    socket.on('disconnect', () => {
      socket.leave(`user:${userId}`);
      console.log('Socket disconnected:', { userId, socketId: socket.id });
    });

  } catch (error) {
    console.error('Socket connection error:', error);
    socket.disconnect();
  }
};

// Function to notify collaborators
export const notifyCollaborators = async (noteId, message, excludeUserId, type = 'update', specificUserIds = null) => {
  if (!io) {
    console.warn('Socket.io not initialized');
    return;
  }

  try {
    const note = await Note.findById(noteId)
      .populate('collaborators.userId', '_id name email')
      .populate('createdBy', '_id name email');

    if (!note) {
      console.warn('Note not found for notification:', noteId);
      return;
    }

    console.log('Sending notification about note:', {
      noteId,
      message,
      excludeUserId: excludeUserId?.toString(),
      type,
      specificUserIds: specificUserIds ? specificUserIds.map(id => id.toString()) : null,
      creatorId: note.createdBy?._id?.toString(),
      collaboratorIds: note.collaborators.map(c => c.userId?._id?.toString())
    });

    let usersToNotify = [];
    
    // If specific user IDs were provided (like for share notifications)
    if (specificUserIds && specificUserIds.length > 0) {
      // Get only the specific users we want to notify
      const allPossibleUsers = [
        note.createdBy,
        ...note.collaborators.map(c => c.userId)
      ].filter(Boolean);
      
      usersToNotify = allPossibleUsers.filter(user => 
        specificUserIds.some(id => user._id.equals(id))
      );
    }
    // Otherwise notify all collaborators except the one who triggered the action
    else {
      usersToNotify = [
        ...(note.createdBy?._id && !note.createdBy._id.equals(excludeUserId) ? [note.createdBy] : []),
        ...note.collaborators
          .filter(c => c.userId && !c.userId._id.equals(excludeUserId))
          .map(c => c.userId)
      ];
    }

    if (usersToNotify.length === 0) {
      console.log('No users to notify');
      return;
    }

    console.log('Sending notifications to users:', usersToNotify.map(u => ({
      userId: u._id.toString(),
      name: u.name,
      email: u.email
    })));

    // Create notifications in database
    const notifications = await Promise.all(
      usersToNotify.map(user => 
        new Notification({
          userId: user._id,
          noteId,
          message,
          type
        }).save()
      )
    );

    // Emit to each user's room
    usersToNotify.forEach(user => {
      const userNotification = notifications.find(n => n.userId.equals(user._id));
      if (userNotification) {
        console.log(`Emitting notification to user:${user._id}`);
        io.to(`user:${user._id}`).emit('notification', {
          _id: userNotification._id,
          message,
          noteId,
          type,
          timestamp: new Date()
        });
      }
    });
  } catch (error) {
    console.error('Error sending notifications:', error);
  }
}; 