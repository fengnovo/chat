import { loadConfig } from './config.js';
import { startKnowledgeService } from './index.js';

await startKnowledgeService(loadConfig());
