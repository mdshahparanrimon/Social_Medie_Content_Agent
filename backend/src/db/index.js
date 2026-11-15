// All storage goes through one repository object, so the database can be swapped
// (MongoDB Atlas now; local MongoDB or PostgreSQL later) by adding a driver file here.
// A new driver must export `connect()` resolving to an object with the same methods as mongo.js.
const DRIVERS = {
  mongodb: () => import('./mongo.js'),
};

export let repo;

// Tests install an in-memory repository (see test/memoryRepo.js); production always uses connectDatabase().
export function useRepo(replacement) {
  if (process.env.NODE_ENV !== 'test') throw new Error('useRepo is only available when NODE_ENV=test.');
  repo = replacement;
}

export async function connectDatabase() {
  const name = process.env.DB_DRIVER || 'mongodb';
  const load = DRIVERS[name];
  if (!load) throw new Error(`Unsupported DB_DRIVER "${name}". Available: ${Object.keys(DRIVERS).join(', ')}.`);
  repo = await (await load()).connect();
  return repo;
}
