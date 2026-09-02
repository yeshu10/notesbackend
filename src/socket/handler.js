import jwt from 'jsonwebtoken';
import Note from '../models/Note.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';

let io;

// Map of noteId -> Map of socketId -> { socketId, userId, name, email }
const roomPresence = new Map();

export const initializeSocket = (socketIo) => {
  io = socketIo;
};

// Helper function to safely compare MongoDB ObjectIDs
const safeIdEquals = (id1, id2) => {
  if (!id1 || !id2) return false;
  try {
    if (id1.equals && typeof id1.equals === 'function') {
      return id1.equals(id2);
    }
    return String(id1) === String(id2);
  } catch (error) {
    return String(id1) === String(id2);
  }
};

const broadcastPresence = (noteId) => {
  if (!io) return;
  const presenceMap = roomPresence.get(String(noteId));
  const activeUsers = presenceMap ? Array.from(presenceMap.values()) : [];

  // De-duplicate users by userId for clean avatar list
  const uniqueUsers = [];
  const seen = new Set();
  for (const user of activeUsers) {
    if (!seen.has(user.userId)) {
      seen.add(user.userId);
      uniqueUsers.push(user);
    }
  }

  io.to(`note:${noteId}`).emit('room-presence-updated', {
    noteId,
    activeUsers: uniqueUsers
  });
};

export const socketHandler = async (socket) => {
  let authenticatedUser = null;

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

    const userDoc = await User.findById(userId).select('name email _id');
    if (!userDoc) {
      socket.disconnect();
      return;
    }

    authenticatedUser = {
      socketId: socket.id,
      userId: userDoc._id.toString(),
      name: userDoc.name,
      email: userDoc.email
    };

    console.log('Socket connected:', { userId: authenticatedUser.userId, name: authenticatedUser.name });
    socket.join(`user:${authenticatedUser.userId}`);

    // Join note room
    socket.on('join-note', async (noteId) => {
      try {
        if (!noteId) return;

        const note = await Note.findById(noteId)
          .populate('createdBy', 'name email _id')
          .populate('collaborators.userId', 'name email _id');

        if (!note) return;

        const isCreator = safeIdEquals(note.createdBy, authenticatedUser.userId);
        const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, authenticatedUser.userId));
        const hasAccess = isCreator || collaborator;

        if (hasAccess) {
          socket.join(`note:${noteId}`);

          // Add to room presence
          const noteKey = String(noteId);
          if (!roomPresence.has(noteKey)) {
            roomPresence.set(noteKey, new Map());
          }
          roomPresence.get(noteKey).set(socket.id, authenticatedUser);

          broadcastPresence(noteId);
          console.log(`User ${authenticatedUser.name} joined room note:${noteId}`);
        }
      } catch (error) {
        console.error('Error joining note room:', error);
      }
    });

    // Leave note room
    socket.on('leave-note', (noteId) => {
      if (!noteId) return;
      socket.leave(`note:${noteId}`);

      const noteKey = String(noteId);
      if (roomPresence.has(noteKey)) {
        roomPresence.get(noteKey).delete(socket.id);
        if (roomPresence.get(noteKey).size === 0) {
          roomPresence.delete(noteKey);
        } else {
          broadcastPresence(noteId);
        }
      }
    });

    // Handle note real-time updates
    socket.on('note-update', async ({ noteId, content, title }) => {
      try {
        if (!noteId) return;
        const note = await Note.findById(noteId)
          .populate('createdBy', 'name email _id')
          .populate('collaborators.userId', 'name email _id');

        if (!note) return;

        const isCreator = safeIdEquals(note.createdBy, authenticatedUser.userId);
        const collaborator = note.collaborators.find(c => c.userId && safeIdEquals(c.userId, authenticatedUser.userId));
        const canWrite = isCreator || (collaborator && (collaborator.permission === 'write' || collaborator.permission === 'editor'));

        if (!canWrite) return;

        // Update note fields
        if (content !== undefined) note.content = content;
        if (title !== undefined) note.title = title.trim() || 'Untitled Note';
        note.lastUpdated = new Date();
        await note.save();

        // Broadcast update to other users in note room
        socket.to(`note:${noteId}`).emit('note-updated', {
          _id: noteId,
          content,
          title,
          lastUpdated: note.lastUpdated,
          updatedBy: {
            id: authenticatedUser.userId,
            name: authenticatedUser.name
          }
        });

      } catch (error) {
        console.error('Error updating note in real-time:', error);
      }
    });

    // Clean up on disconnect
    socket.on('disconnect', () => {
      if (authenticatedUser) {
        socket.leave(`user:${authenticatedUser.userId}`);

        // Remove socket from all room presences
        for (const [noteId, presenceMap] of roomPresence.entries()) {
          if (presenceMap.has(socket.id)) {
            presenceMap.delete(socket.id);
            if (presenceMap.size === 0) {
              roomPresence.delete(noteId);
            } else {
              broadcastPresence(noteId);
            }
          }
        }
      }
    });

  } catch (error) {
    console.error('Socket connection error:', error);
    socket.disconnect();
  }
};

// Function to notify collaborators
export const notifyCollaborators = async (noteId, message, excludeUserId, type = 'update', specificUserIds = null) => {
  if (!io) return;

  try {
    const note = await Note.findById(noteId)
      .populate('collaborators.userId', '_id name email')
      .populate('createdBy', '_id name email');

    if (!note) return;

    let usersToNotify = [];

    if (specificUserIds && specificUserIds.length > 0) {
      const allPossibleUsers = [
        note.createdBy,
        ...note.collaborators.map(c => c.userId)
      ].filter(Boolean);

      usersToNotify = allPossibleUsers.filter(user =>
        specificUserIds.some(id => safeIdEquals(user._id || user, id))
      );
    } else {
      usersToNotify = [
        ...(note.createdBy && !safeIdEquals(note.createdBy, excludeUserId) ? [note.createdBy] : []),
        ...note.collaborators
          .filter(c => c.userId && !safeIdEquals(c.userId, excludeUserId))
          .map(c => c.userId)
      ];
    }

    if (usersToNotify.length === 0) return;

    const notifications = await Promise.all(
      usersToNotify.map(user =>
        new Notification({
          userId: user._id || user,
          noteId,
          message,
          type
        }).save()
      )
    );

    usersToNotify.forEach(user => {
      const uid = user._id || user;
      const userNotification = notifications.find(n => safeIdEquals(n.userId, uid));
      if (userNotification) {
        io.to(`user:${uid}`).emit('notification', {
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