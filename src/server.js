import { createApp } from './app.js';
import { createDatabase } from './config/database.js';
import { loadEnv } from './config/env.js';
import { createServices } from './container.js';

const config = loadEnv();
const database = createDatabase(config);
const services = createServices({ config, database });
const { integrityService, demoService } = services;

// Express application
const app = createApp({
  ...services,
  corsOrigin: config.CORS_ORIGIN
});

// Start server
const server = app.listen(config.PORT, () => {
  console.log(`MediVault API listening on port ${config.PORT}`);
});

const stopIntegrity = integrityService.start();

// With DEMO_MODE=true, creates the demo accounts and their sample data once.
demoService.seedInBackground();

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down MediVault API...');
  stopIntegrity();

  server.close(async () => {
    try {
      await database.close();
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

