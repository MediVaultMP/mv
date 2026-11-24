import { createDatabase } from '../config/database.js';
import { loadEnv } from '../config/env.js';
import { createServices } from '../container.js';

// Creates the demo patient, doctor and pharmacy with a basic profile, a
// prescription and a lab report, all signed and registered on chain.
// Usage: npm run demo:seed  (safe to run again; it only adds what is missing)
const config = loadEnv({ ...process.env, DEMO_MODE: 'true' });
const database = createDatabase(config, { client: 'script' });

try {
  const { demoService } = createServices({ config, database });
  await demoService.seed();
  for (const account of demoService.publicAccounts().accounts) {
    console.log(`${account.role.padEnd(9)} ${account.email}  password: ${account.password}`);
  }
} finally {
  await database.close();
}
