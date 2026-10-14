'use strict';

const { createApp } = require('./app');

async function main() {
  const app = createApp({ logRequests: process.env.LOG_REQUESTS === '1' });
  const address = await app.start();
  const host = address.address === '0.0.0.0' || address.address === '::' ? 'localhost' : address.address;
  console.log(`Business Auto-Pilot is running at http://${host}:${address.port}`);
  console.log(`Database: ${app.config.dbPath}`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received, shutting down gracefully...`);
    const force = setTimeout(() => process.exit(1), 15000);
    force.unref();
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
