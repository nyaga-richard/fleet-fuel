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

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build

# ---- Runtime ----
FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# NOTE: the Docker build context is web/ only, so the build stage has no
# parent workspace package.json and Next emits a FLAT standalone tree
# (server.js at the standalone root). Do NOT "fix" the paths to web/server.js —
# that only exists when building from the repo workspace root.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
