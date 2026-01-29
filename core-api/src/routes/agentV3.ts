import { Router, Request, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { processWithOrchestrator, OrchestratorInput } from '../services/agent/index.js';
import prisma from '../services/prisma.js';

const router = Router();

const USE_V3_AGENT = process.env.USE_V3_AGENT === 'true';

router.post('/process', authMiddleware, async (req: AuthRequest, res: Response) => {
  const startTime = Date.now();
  
  try {
    const { businessId, instanceId, contactPhone, contactName, messages, triggerContext } = req.body;

    if (!businessId || !contactPhone || !messages || !Array.isArray(messages)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: businessId, contactPhone, messages (array)'
      });
    }

    console.log(`[AgentV3] Processing request for ${contactPhone}`);

    const input: OrchestratorInput = {
      businessId,
      instanceId: instanceId || null,
      contactPhone,
      contactName: contactName || 'Cliente',
      messages,
      triggerContext,
      config: {
        model: req.body.model || 'gpt-4o-mini',
        temperature: req.body.temperature || 0.7,
        maxTokens: req.body.maxTokens || 2000,
        maxToolCalls: req.body.maxToolCalls || 5
      }
    };

    const result = await processWithOrchestrator(input);

    const processingTime = Date.now() - startTime;
    console.log(`[AgentV3] Request completed in ${processingTime}ms`);

    return res.json({
      success: true,
      response: result.response,
      toolsExecuted: result.toolsExecuted,
      tokensUsed: result.tokensUsed,
      metadata: {
        ...result.metadata,
        version: 'v3',
        processingTimeMs: processingTime
      }
    });
  } catch (error: any) {
    console.error('[AgentV3] Error processing request:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

router.get('/status', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { toolRegistry } = await import('../services/agent/index.js');
    const stats = toolRegistry.getStats();
    
    return res.json({
      success: true,
      version: 'v3',
      enabled: USE_V3_AGENT,
      toolRegistry: stats,
      envVar: process.env.USE_V3_AGENT
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.get('/tools', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { toolRegistry } = await import('../services/agent/index.js');
    const allTools = toolRegistry.getAllToolNames();
    
    return res.json({
      success: true,
      tools: allTools,
      count: allTools.length
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
export { USE_V3_AGENT };
