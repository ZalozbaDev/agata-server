import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import dotenv from 'dotenv'
import { connectDB } from './config/database'
import { errorHandler } from './middleware/errorHandler'
import routes from './routes'
import OpenAI from 'openai'

// Load environment variables
dotenv.config()

const app = express()
const PORT = process.env['PORT'] || 3000
export const openAI = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'] || 'OPENAI_API_KEY',
})

// Middleware
app.use(helmet())
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Routes
app.use('/api', routes)

// Health check route
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Server is running',
    timestamp: new Date().toISOString(),
  })
})

// Error handling middleware
app.use(errorHandler)

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
  })
})

// Start server
const startServer = async (): Promise<void> => {
  try {
    // Connect to database
    await connectDB()

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`)
      console.log(`📊 Environment: ${process.env['NODE_ENV'] || 'development'}`)
      console.log(`🔗 Health check: http://localhost:${PORT}/health`)
    })
  } catch (error) {
    console.error('❌ Failed to start server:', error)
    process.exit(1)
  }
}

startServer()
