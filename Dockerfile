# Dockerfile — used by Dokploy to build and run the app.
#
# Small, single-stage image: this app has no frontend build step (the
# public/ files are already plain HTML/CSS/JS, served as-is by Express), so
# there's nothing to compile — just install production dependencies and run
# the server.

FROM node:20-alpine

WORKDIR /app

# Copy just the manifest files first so Docker can cache the npm install
# layer — it only re-runs when package.json/package-lock.json actually
# change, not on every code edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Now copy the rest of the app (server.js, db.js, public/).
COPY . .

ENV NODE_ENV=production

# The app reads PORT from the environment (defaulting to 3000 if unset —
# see server.js) — Dokploy can override this, or leave it as-is and map
# port 3000 in its dashboard.
EXPOSE 3000

CMD ["node", "server.js"]