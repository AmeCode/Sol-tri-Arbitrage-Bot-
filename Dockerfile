FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

RUN npm run build 
RUN npm prune --omit=dev

ENV NODE_ENV=production
CMD ["npm","start"]
