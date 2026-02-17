FROM node:22-alpine AS app

WORKDIR /app

# Copy lockfiles first for deterministic installs
COPY package.json package-lock.json ./
COPY extensions ./extensions

# Install ALL deps (build requires dev deps)
RUN npm ci

# Copy app source and build
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm","run","start"]
