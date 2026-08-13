import mongoose from 'mongoose'

const isAtlasHost = (host: string) => host.includes('.mongodb.net')

const buildMongoUri = () => {
  const {
    MONGODB_URI,
    MONGODB_USERNAME,
    MONGODB_PASSWORD,
    MONGODB_HOST,
    MONGODB_DATABASE,
  } = process.env

  if (MONGODB_URI) {
    return MONGODB_URI
  }

  if (!MONGODB_USERNAME || !MONGODB_PASSWORD || !MONGODB_HOST) {
    throw new Error(
      'Missing MongoDB config: set MONGODB_URI or MONGODB_USERNAME, MONGODB_PASSWORD, and MONGODB_HOST',
    )
  }

  const user = encodeURIComponent(MONGODB_USERNAME)
  const pass = encodeURIComponent(MONGODB_PASSWORD)
  const host = isAtlasHost(MONGODB_HOST)
    ? MONGODB_HOST.replace(/:\d+$/, '')
    : MONGODB_HOST
  const protocol = isAtlasHost(MONGODB_HOST) ? 'mongodb+srv' : 'mongodb'
  const database = MONGODB_DATABASE ? `/${MONGODB_DATABASE}` : ''

  const authSource = MONGODB_DATABASE ? `?authSource=${MONGODB_DATABASE}` : ''
  return `${protocol}://${user}:${pass}@${host}${database}${authSource}`
}

export const connectDB = async () => {
  try {
    await mongoose.connect(buildMongoUri())
    console.log('🚀 Connected to MongoDB')
  } catch (error) {
    console.log('❌ Error connecting to MongoDB:', error)
    process.exit(1)
  }
}
