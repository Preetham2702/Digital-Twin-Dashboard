FROM node:20

WORKDIR /app

# copy only package files first (cache optimization)
COPY package.json package-lock.json ./
RUN npm install

# now copy everything
COPY . .

# IMPORTANT: build using vite only
RUN npm run build

# serve with nginx
FROM nginx:alpine
COPY --from=0 /app/dist /usr/share/nginx/html