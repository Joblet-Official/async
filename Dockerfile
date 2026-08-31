# Runtime image for the Async MCP server.
# The server runs TypeScript directly via tsx (same as `npm start`),
# so there is no separate build step.
FROM node:24-slim

WORKDIR /app

# Install dependencies first for better layer caching.
# NOTE: devDependencies (tsx) are required AT RUNTIME because the server is
# executed straight from TypeScript, so we do a full install (no --omit=dev).
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source.
COPY . .

# Render injects PORT at runtime; the server reads process.env.PORT (falls back to 3001).
EXPOSE 3001

CMD ["npm", "start"]
