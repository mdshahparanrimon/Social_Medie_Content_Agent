// Import first in every test file: marks the process as a test run and keeps tests away from real storage.
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY ||= 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktMzJieXRlcw==';
process.env.PUBLIC_API_URL = 'http://localhost:4000';
process.env.UPLOAD_DIR ||= path.join(os.tmpdir(), `ca-test-uploads-${process.pid}`);
process.env.INGEST_TMP_DIR ||= path.join(os.tmpdir(), `ca-test-ingest-${process.pid}`);
