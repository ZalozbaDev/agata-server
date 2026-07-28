# build container
FROM node:24 AS serverbuild
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# RUN ls -l

# deployment container
FROM nginx:stable-alpine

COPY --from=serverbuild /app/dist /usr/share/nginx/html
# internal port is 80
CMD ["nginx", "-g", "daemon off;"]
