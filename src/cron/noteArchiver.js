import cron from 'node-cron';
import Note from '../models/Note.js';

// Archive notes that haven't been updated in 30 days
const archiveOldNotes = async () => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    try {
        const result = await Note.updateMany(
            {
                lastUpdated: { $lt: thirtyDaysAgo },
                isArchived: false
            },
            {
                $set: { 
                    isArchived: true,
                    archivedAt: new Date()
                }
            }
        );

        console.log(`Archived ${result.modifiedCount} notes`);
    } catch (error) {
        console.error('Error archiving notes:', error);
    }
};

// Run at midnight every day
export const initializeArchiver = () => {
    cron.schedule('0 0 * * *', archiveOldNotes);
    console.log('Note archiver CRON job initialized');
}; 