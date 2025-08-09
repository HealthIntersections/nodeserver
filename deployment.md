# Deployment Guide

This document outlines how to deploy the Node SHL API in various environments.

## Docker Deployment

The recommended way to deploy this application is using Docker.

### Simple Single-Server Deployment

```bash
# Pull the latest release
docker pull ghcr.io/healthintersections/nodeserver:latest

# Run with environment variables
docker run -d --name fhir-server \
  -p 3000:3000 \
  -e DATABASE_PATH=/data/shl.db \
  -e LOG_LEVEL=info \
  -v /path/on/host:/data \
  ghcr.io/healthintersections/nodeserver:latest
```

### Docker Compose Deployment

Create a `docker-compose.yml` file:

```yaml
version: '3'

services:
  fhir-server:
    image: ghcr.io/healthintersections/nodeserver:latest
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_PATH=/data/shl.db
      - LOG_LEVEL=info
    volumes:
      - ./data:/data
    restart: unless-stopped
```

Then run:

```bash
docker-compose up -d
```

## Configuration

The application can be configured using environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Port for the server to listen on | `3000` |
| `DATABASE_PATH` | Path to SQLite database file | `./shl.db` |
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | `info` |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated) | `*` |

## Multi-Environment Setup

For deploying to multiple environments (development, staging, production), use environment-specific configuration files or environment variables.

### Environment-Specific Docker Tags

- Development: `ghcr.io/healthintersections/nodeserver:cibuild`
- Staging: Use a specific version like `ghcr.io/healthintersections/nodeserver:v1.2.3`
- Production: Use `ghcr.io/healthintersections/nodeserver:latest` or a specific version

### Automatic Updates

For development environments, you can set up automatic updates using a simple script:

```bash
#!/bin/bash
# update-shl-api.sh

# Pull latest cibuild image
docker pull ghcr.io/healthintersections/nodeserver:cibuild

# Restart container
docker stop fhir-server || true
docker rm fhir-server || true
docker run -d --name fhir-server \
  -p 3000:3000 \
  -e NODE_ENV=development \
  -e DATABASE_PATH=/data/shl.db \
  -v /path/on/host:/data \
  ghcr.io/healthintersections/nodeserver:cibuild
```

Add this script to a cron job:

```
# Update SHL API daily at 2 AM
0 2 * * * /path/to/update-shl-api.sh >> /var/log/update-shl-api.log 2>&1
```

## Manual Deployment (without Docker)

If you prefer to deploy without Docker:

1. Install Node.js 18+ on your server
2. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/node-shl-api.git
   cd node-shl-api
   ```
3. Install production dependencies:
   ```bash
   npm ci --only=production
   ```
4. Configure environment variables:
   ```bash
   export NODE_ENV=production
   export PORT=3000
   export DATABASE_PATH=/path/to/shl.db
   ```
5. Start the server:
   ```bash
   node server.js
   ```

For production use, consider using a process manager like PM2:

```bash
# Install PM2
npm install -g pm2

# Start the application
pm2 start server.js --name node-shl-api

# Enable startup script
pm2 startup
pm2 save
```

## Deployment to Cloud Platforms

### AWS Elastic Beanstalk

1. Package your application:
   ```bash
   zip -r node-shl-api.zip . -x "node_modules/*" ".git/*"
   ```
2. Create a new Elastic Beanstalk application using the Node.js platform
3. Upload the ZIP file
4. Configure environment variables in the Elastic Beanstalk console

### Digital Ocean App Platform

1. Connect your GitHub repository to Digital Ocean
2. Create a new App
3. Select Node.js as the platform
4. Configure build command: `npm ci --only=production`
5. Configure run command: `node server.js`
6. Add environment variables as needed

## Health Checks and Monitoring

Add a health check endpoint to your application:

```javascript
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    version: process.env.APP_VERSION || 'unknown',
    timestamp: new Date().toISOString()
  });
});
```

Configure your deployment platform to use this endpoint for health checks.
