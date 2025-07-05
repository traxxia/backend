# Stage 1: Base Node.js environment
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY ../package*.json ./
RUN npm install --only=production

# Copy source code (excluding node_modules via .dockerignore)
COPY ../ ./

# Optional: Copy uploads folder (if runtime needs it pre-created)
RUN mkdir -p uploads

# Expose backend port
EXPOSE 5000

# Start the server
CMD ["node", "server.js"]
