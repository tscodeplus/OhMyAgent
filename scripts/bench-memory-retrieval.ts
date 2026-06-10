import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { applySchema } from '../src/memory/schema.js';
import { MemoryRepository } from '../src/memory/repositories/memory-repository.js';
import { EmbeddingRepository } from '../src/memory/repositories/embedding-repository.js';

const DIM = 16;
const SIZES = [1000, 5000, 20000];

function vector(seed: number): Float32Array {
  const values = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) values[i] = Math.sin(seed + i);
  return values;
}

for (const size of SIZES) {
  const db = new Database(':memory:');
  applySchema(db);
  const memoryRepo = new MemoryRepository(db);
  const embeddingRepo = new EmbeddingRepository(db);

  const insertStart = performance.now();
  const tx = db.transaction(() => {
    for (let i = 0; i < size; i++) {
      const id = `mem-${i}`;
      memoryRepo.create({
        id,
        scope: 'user',
        scope_key: '',
        kind: 'fact',
        content: `Synthetic memory ${i}`,
      });
      embeddingRepo.create({
        id: `emb-${i}`,
        memory_id: id,
        embedding: vector(i),
        model: 'bench',
        dimension: DIM,
      });
    }
  });
  tx();

  const query = vector(42);
  const fullStart = performance.now();
  embeddingRepo.cosineSearch(query, 10);
  const fullMs = performance.now() - fullStart;

  const candidateIds = Array.from({ length: Math.min(200, size) }, (_, i) => `mem-${i}`);
  const filteredStart = performance.now();
  embeddingRepo.cosineSearch(query, 10, candidateIds);
  const filteredMs = performance.now() - filteredStart;

  console.log(JSON.stringify({
    size,
    insertMs: Math.round(performance.now() - insertStart),
    fullScanMs: Math.round(fullMs * 100) / 100,
    candidateScanMs: Math.round(filteredMs * 100) / 100,
    fullScanGuardRecommended: size > 5000,
  }));

  db.close();
}
