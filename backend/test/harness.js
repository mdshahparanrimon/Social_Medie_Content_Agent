import './env.js';
import { useRepo, repo } from '../src/db/index.js';
import { runInWorkspace } from '../src/context.js';
import { saveBrand } from '../src/brandBrain.js';
import { createMemoryRepo } from './memoryRepo.js';
import { setLogSink, resetMetrics } from '../src/log.js';

// A fresh in-memory database, a captured log, and a configured brand, for each test that needs them.
export const logs = [];

export function freshDatabase() {
  useRepo(createMemoryRepo());
  logs.length = 0;
  setLogSink((entry) => logs.push(entry));
  resetMetrics();
  return repo;
}

export const WS = 'ws-one';
export const inWorkspace = (fn, ws = WS) => runInWorkspace(ws, fn);

export const BRAND = {
  name: 'Acme Studio',
  description: 'A small design studio.',
  goal: 'awareness',
  audience: 'Founders of small businesses in Bangladesh',
  tone: 'Warm, practical, plain language',
  language: 'English',
  pillars: ['Branding basics', 'Design process'],
  platforms: ['x', 'linkedin', 'meta', 'instagram'],
};

export async function seedBrand(extra = {}) {
  await saveBrand({ ...BRAND, ...extra });
}

export async function setWorkspaceSettings(values) {
  await repo.saveWorkspaceSettings(values);
}

export const GOOD_LINKEDIN =
  'Most logos fail for one boring reason: nobody wrote down what the brand should feel like.\n\nBefore you open a design tool, write three adjectives and one thing you refuse to be.\n\nWhat are your three? Tell me in the comments.\n\n#Branding #SmallBusiness #Design';
