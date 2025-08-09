FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm ci --only=production

# Bundle app source
COPY . .

# Define build argument for version
ARG VERSION=development
ENV APP_VERSION=$VERSION

# Expose port and define command
EXPOSE 3000
CMD ["node", "server.js"]
