# Multi-stage build for the embedding service.
#
# Build stage: install all deps (including dev), compile TypeScript
# Runtime stage: slim image with only prod deps + compiled JS

# -----------------------------------------------------------------------------
# Build stage
# -----------------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Install all deps including dev
COPY package.json ./
RUN npm install

# Copy source and compile
COPY tsconfig.json ./
COPY src ./src
RUN npm run build


# -----------------------------------------------------------------------------
# Runtime stage
# -----------------------------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

# Install only production deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy compiled output
COPY --from=build /app/dist ./dist

# Health server port (matches HEALTH_PORT default)
EXPOSE 8081

# Run as non-root user
RUN addgroup -S app && adduser -S app -G app
USER app

# Graceful shutdown on SIGTERM
STOPSIGNAL SIGTERM

CMD ["node", "dist/scheduler.js"]
