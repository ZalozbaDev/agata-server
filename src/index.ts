import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { connectDB } from './config/database'
import { errorHandler } from './middleware/errorHandler'
import routes from './routes'
import http from 'http'
import { startSipClientBridge } from './telephony/sipBridge'

const app = express()
const PORT = process.env['PORT'] || 3000

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

const server = http.createServer(app)

// Start server
const startServer = async (): Promise<void> => {
  try {
    // Connect to database
    await connectDB()

    // Start SIP-client (Asterisk) phone bridge
    if (process.env['SIP_ENABLED'] === 'true') {
      startSipClientBridge()
    }

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`)
      console.log(`📊 Environment: ${process.env['NODE_ENV'] || 'development'}`)
      console.log(`🔗 Health check: http://localhost:${PORT}/health`)
      // console.log(`🔄 Data fetching interval: ${fetchInterval}ms`)
    })
  } catch (error) {
    console.error('❌ Failed to start server:', error)
    process.exit(1)
  }
}

startServer()
