# Agata Server

A modern Express.js server built with TypeScript, featuring MongoDB integration with Mongoose, comprehensive linting, and development tools.

## Features

- ⚡ **Express.js** with TypeScript
- 🗄️ **MongoDB** integration with Mongoose
- 🛡️ **Security** with Helmet and CORS
- 🔧 **ESLint** with TypeScript support
- 🚀 **Hot reload** with Nodemon
- 📝 **Environment** configuration
- 🏥 **Health check** endpoint
- 🎯 **Error handling** middleware

## Prerequisites

- Node.js (v16 or higher)
- MongoDB (local or cloud instance)
- npm or yarn

## Installation

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd agata-server
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Set up environment variables**

   ```bash
   cp env.example .env
   ```

   Edit `.env` file with your configuration:

   ```env
   PORT=3000
   NODE_ENV=development
   MONGODB_USERNAME=dummy
   MONGODB_PASSWORD=your-password
   MONGODB_HOST=localhost:27017
   MONGODB_DATABASE=agata
   ```

4. **Start MongoDB** (if using local instance)

   ```bash
   # macOS with Homebrew
   brew services start mongodb-community

   # Or start manually
   mongod
   ```

## Development

### Start development server

```bash
npm run dev
```

### Build for production

```bash
npm run build
```

### Start production server

```bash
npm start
```

### Linting

```bash
# Check for linting errors
npm run lint

# Fix linting errors automatically
npm run lint:fix
```

## API Endpoints

### Health Check

- **GET** `/health` - Server health status

### API Routes

- **GET** `/api` - API information
- **GET** `/api/hello` - Hello World endpoint

## Project Structure

```
src/
├── config/
│   └── database.ts      # MongoDB connection
├── middleware/
│   └── errorHandler.ts  # Error handling middleware
├── routes/
│   └── index.ts         # Main routes
└── index.ts             # Server entry point
```

## Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Fix ESLint errors automatically

## Environment Variables

| Variable           | Description            | Default                              |
| ------------------ | ---------------------- | ------------------------------------ |
| `PORT`             | Server port            | `3000`                               |
| `NODE_ENV`         | Environment            | `development`                        |
| `MONGODB_USERNAME` | MongoDB username       | — (required)                         |
| `MONGODB_PASSWORD` | MongoDB password       | — (required)                         |
| `MONGODB_HOST`     | MongoDB host           | — (required)                         |
| `MONGODB_DATABASE` | MongoDB database name  | `agata`                              |

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run linting: `npm run lint`
5. Submit a pull request

## License

MIT License
