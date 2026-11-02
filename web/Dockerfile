# ---- Dependencies ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

# ---- Build (Next.js standalone output) ----
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Server-side backend URL for the container (service name in compose).
ARG BACKEND_URL=http://backend:4000
ENV BACKEND_URL=$BACKEND_URL
RUN npm run build

# ---- Runtime ----
FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# The standalone tree nests the app under its directory name (web/):
#   standalone/node_modules + standalone/web/server.js
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./web/.next/static
EXPOSE 3000
CMD ["node", "web/server.js"]
