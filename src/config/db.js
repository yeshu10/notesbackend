import mongoose from 'mongoose';

const connectDB = async () => {
  const primaryUri = process.env.MONGODB_URI;
  const fallbackUri = 'mongodb://127.0.0.1:27017/collaborative-notes';

  try {
    const conn = await mongoose.connect(primaryUri || fallbackUri);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);

    if (error.message.includes('bad auth') || error.message.includes('Authentication failed')) {
      console.error('\n=============================================================');
      console.error('🔑 MONGODB ATLAS AUTHENTICATION FAILURE DIAGNOSIS');
      console.error('=============================================================');
      console.error('The database username or password in your backend/.env file was rejected by MongoDB Atlas.');
      console.error('\nTo fix this in MongoDB Atlas:');
      console.error('1. Open MongoDB Atlas (https://cloud.mongodb.com)');
      console.error('2. Go to Security -> Database Access');
      console.error('3. Click "Edit" on user "itsyeshu10" (or create a new user)');
      console.error('4. Click "Edit Password" -> Set a clean password without special characters (e.g. MyNotesPass123)');
      console.error('5. Update backend/.env with your new password:');
      console.error('   MONGODB_URI=mongodb+srv://itsyeshu10:<YOUR_NEW_PASSWORD>@cluster1.qepbicp.mongodb.net/collabnotesdb?retryWrites=true&w=majority');
      console.error('=============================================================\n');

      // Attempt local fallback connection if available
      try {
        console.log('Attempting local MongoDB fallback (mongodb://127.0.0.1:27017)...');
        const conn = await mongoose.connect(fallbackUri);
        console.log(`✅ Connected to local MongoDB fallback: ${conn.connection.host}`);
        return;
      } catch (fallbackErr) {
        console.error('Local MongoDB fallback not available.');
      }
    } else if (error.message.includes('ENOTFOUND') || error.message.includes('querySrv')) {
      console.error('--> DNS Lookup Failed: Check if your MongoDB Atlas cluster domain is correct.');
    }

    // Do not call process.exit(1) so nodemon stays alive while the user updates .env
  }
};

export default connectDB;