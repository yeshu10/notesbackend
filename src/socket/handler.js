import jwt from 'jsonwebtoken';
import Note from '../models/Note.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';
import NoteVersion from '../models/NoteVersion.js';

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

export const getIO = () => io;

export const saveNoteVersionAndNotify = async ({
  noteId,
  title,
  content,
  userId,
  userName,
  changeType = 'updated',
  forceNewVersion = false,
  sessionId = null
}) => {
  try {
    const latestVersion = await NoteVersion.findOne({ noteId }).sort({ versionNumber: -1 });

    if (latestVersion) {
      // Avoid creating duplicate version if content and title are identical to latest version
      if (latestVersion.title === title && latestVersion.content === content) {
        return { version: latestVersion, isNewVersion: false };
      }

      // Strictly check if edits belong to the exact same editing session
      let isSameSession = false;
      if (sessionId && latestVersion.sessionId) {
        isSameSession = (latestVersion.sessionId === sessionId);
      } else {
        const timeThreshold = 5 * 1000; // 5s fallback if no sessionId provided
        isSameSession = (Date.now() - new Date(latestVersion.updatedAt || latestVersion.createdAt).getTime() < timeThreshold);
      }

      const canUpdateInPlace =
        !forceNewVersion &&
        isSameSession &&
        latestVersion.changeType === 'updated' &&
        latestVersion.editedBy.toString() === userId.toString() &&
        changeType === 'updated';

      if (canUpdateInPlace) {
        latestVersion.title = title;
        latestVersion.content = content;
        await latestVersion.save();
        return { version: latestVersion, isNewVersion: false };
      }
    }

    const versionCount = await NoteVersion.countDocuments({ noteId });
    const newVersion = await NoteVersion.create({
      noteId,
      title,
      content,
      editedBy: userId,
      versionNumber: versionCount + 1,
      changeType,
      sessionId
    });

    const actionText = changeType === 'restored' ? 'restored a previous version of' : 'edited';
    await notifyCollaborators(
      noteId,
      `${userName} ${actionText} "${title}"`,
      userId,
      changeType === 'restored' ? 'NOTE_RESTORED' : 'NOTE_EDITED'
    );

    return { version: newVersion, isNewVersion: true };
  } catch (error) {
    console.error('Error saving note version / notifying:', error);
  }
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
    socket.on('note-update', async ({ noteId, content, title, sessionId }) => {
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

        const newTitle = title !== undefined ? title.trim() || 'Untitled Note' : note.title;
        const newContent = content !== undefined ? content : note.content;
        const hasContentOrTitleChanged = (newTitle !== note.title) || (newContent !== note.content);

        // Update note fields
        if (content !== undefined) note.content = newContent;
        if (title !== undefined) note.title = newTitle;
        note.lastUpdated = new Date();
        await note.save();

        if (hasContentOrTitleChanged) {
          await saveNoteVersionAndNotify({
            noteId: note._id,
            title: note.title,
            content: note.content,
            userId: authenticatedUser.userId,
            userName: authenticatedUser.name,
            changeType: 'updated',
            sessionId
          });
        }

        // Broadcast update to other users in note room
        socket.to(`note:${noteId}`).emit('note-updated', {
          _id: noteId,
          content: note.content,
          title: note.title,
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
          senderId: excludeUserId || null,
          noteId,
          message,
          type
        }).save()
      )
    );

    if (io) {
      usersToNotify.forEach(user => {
        const uid = user._id || user;
        const userNotification = notifications.find(n => safeIdEquals(n.userId, uid));
        if (userNotification) {
          io.to(`user:${uid}`).emit('notification', {
            _id: userNotification._id,
            message,
            noteId,
            type,
            read: false,
            createdAt: userNotification.createdAt || new Date()
          });
        }
      });
    }
  } catch (error) {
    console.error('Error sending notifications:', error);
  }
};