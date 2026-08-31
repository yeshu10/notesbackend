import mongoose from 'mongoose';

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/collaborative-notes');
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`MongoDB Connection Error: ${error.message}`);
    if (error.message.includes('ENOTFOUND') || error.message.includes('querySrv')) {
      console.error('--> DNS Lookup Failed: Check if your MongoDB Atlas cluster is paused or deleted, or if the connection string domain is correct.');
    } else if (error.message.includes('ETIMEDOUT') || error.message.includes('Authentication failed')) {
      console.error('--> Connection Timeout/Auth Error: Check MongoDB Atlas Network Access IP Whitelist (0.0.0.0/0) and database user credentials.');
    }
    process.exit(1);
  }
};

export default connectDB; 