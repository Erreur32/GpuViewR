import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { HostsRepo } from '../database/models/Host.js';
import { llmConfig, LlmConfigError } from '../services/llmConfig.js';
import { pushLlmConfig } from '../services/agentIngestWS.js';

// Settings > LLM: naming rules (global) and per-host LLM endpoints /
// Ollama manifests dir. Read for any signed-in user, write for admins.
// Every change is pushed to the connected agents right away.

const router = Router();
router.use(requireAuth);

router.get('/rules', (_req, res) => {
  res.json({ rules: llmConfig.rules() });
});

router.put('/rules', requireAdmin, (req, res) => {
  try {
    const rules = llmConfig.setRules(req.body?.rules);
    pushLlmConfig();
    res.json({ rules });
  } catch (err) {
    if (err instanceof LlmConfigError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.get('/hosts/:id', (req, res) => {
  const id = String(req.params.id);
  if (!HostsRepo.findById(id)) {
    res.status(404).json({ error: 'unknown host' });
    return;
  }
  res.json({ config: llmConfig.host(id) });
});

router.put('/hosts/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  if (!HostsRepo.findById(id)) {
    res.status(404).json({ error: 'unknown host' });
    return;
  }
  try {
    const config = llmConfig.setHost(id, req.body?.config);
    pushLlmConfig(id);
    res.json({ config });
  } catch (err) {
    if (err instanceof LlmConfigError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
