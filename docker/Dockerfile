# ---------- Stage 1: Build ----------
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files and install dependencies (omit dev dependencies)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source code
COPY . .

# Optional: Run build step if using TypeScript or build tools
# RUN npm run build

# ---------- Stage 2: Runtime ----------
FROM node:18-alpine AS runtime

# Set working directory
WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app .

# Create a non-root user
RUN addgroup -g 1001 appgroup && adduser -D -u 1001 -G appgroup appuser
USER appuser

# No EXPOSE (handled by K8s ingress/service)
# Application starts here
CMD ["node", "server.js"]
