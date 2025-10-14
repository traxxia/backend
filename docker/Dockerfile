# ---------- Stage 1: Build ----------
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy both manifest and lockfile explicitly (ensure lockfile exists and not ignored)
COPY package.json package-lock.json ./

# Clean install with deterministic deps (prod only)
RUN npm ci --omit=dev --no-audit

# Copy application source code
COPY . .

# Optional: run build if using TypeScript or build step
# RUN npm run build

# ---------- Stage 2: Runtime ----------
FROM node:18-alpine AS runtime

# Set working directory
WORKDIR /app

# Copy only necessary files from builder
COPY --from=builder /app ./

# Create uploads directory and fix permissions
RUN mkdir -p /app/uploads \
    && chown -R 1001:1001 /app

# Create a non-root user
RUN addgroup -g 1001 appgroup && adduser -D -u 1001 -G appgroup appuser
USER appuser

# Start the Node.js application
CMD ["node", "server.js"]
