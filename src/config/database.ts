import mongoose from 'mongoose'

const buildMongoURI = (): string => {
  const username = process.env['MONGODB_USERNAME']
  const password = process.env['MONGODB_PASSWORD']
  const host = process.env['MONGODB_HOST']
  const database = process.env['MONGODB_DATABASE'] || 'agata'

  if (!username || !password || !host) {
    throw new Error(
      'Missing MongoDB config: MONGODB_USERNAME, MONGODB_PASSWORD, and MONGODB_HOST are required'
    )
  }

  return `mongodb+srv://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}/${database}?retryWrites=true&w=majority&appName=${database}`
}

export const connectDB = async (): Promise<void> => {
  try {
    const mongoURI = buildMongoURI()

    await mongoose.connect(mongoURI)

    console.log('✅ MongoDB connected successfully')

    // Handle connection events
    mongoose.connection.on('error', error => {
      console.error('❌ MongoDB connection error:', error)
    })

    mongoose.connection.on('disconnected', () => {
      console.log('⚠️ MongoDB disconnected')
    })

    // Graceful shutdown
    process.on('SIGINT', async () => {
      await mongoose.connection.close()
      console.log('🔌 MongoDB connection closed through app termination')
      process.exit(0)
    })
  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error)
    process.exit(1)
  }
}
