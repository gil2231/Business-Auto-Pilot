'use strict';

const config = require('./config');
const db = require('./db');
const { EventBus } = require('./events');
const { Engine } = require('./engine/engine');
const { buildRouter } = require('./routes');
const { createServer } = require('./http/server');
const sweeps = require('./services/sweeps');

// Wires the application together. Used by the CLI entry point and by tests.
function createApp(overrides = {}, { logger = console, now } = {}) {
  const cfg = config.load(overrides);
  const app = { config: cfg, logger };
  app.db = db.open(cfg.dbPath);
  app.events = new EventBus(logger);
  app.engine = new Engine(app, { logger, ...(now ? { now } : {}) });
  app.router = buildRouter(app);
  app.server = createServer(app, app.router);

  let stopSweeps = null;
  app.start = () =>
    new Promise((resolve, reject) => {
      app.engine.start();
      stopSweeps = sweeps.start(app);
      app.server.once('error', reject);
      app.server.listen(cfg.port, cfg.host, () => resolve(app.server.address()));
    });

  app.stop = async () => {
    stopSweeps?.();
    await new Promise((resolve) => {
      if (!app.server.listening) return resolve();
      app.server.close(() => resolve());
      app.server.closeAllConnections?.();
    });
    await app.engine.stop();
    app.db.close();
  };
  return app;
}

module.exports = { createApp };
