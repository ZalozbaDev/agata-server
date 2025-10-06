

import { z } from 'zod';
import { Router, Request, Response } from 'express';
import { Agent, tool, run } from '@openai/agents';

const router = Router();

const getWeather = tool({
    name: 'get_weather',
    description: 'Fetch weather information for a specific location.',
    parameters: z.object({ city: z.string() }),
    async execute({ city }) {
        return `Das Wetter in ${city} ist ausgezeichnet.`
    },
});

const wjedroAgent = new Agent({
    name:'WjedroAgent',
    instructions: 'Gib mir Informationen über das aktuelle Wetter in der angegegebenen Region.',
    tools: [getWeather],
});

router.get('/wjedro', async (req: Request, res: Response) => {
    const { city } = req.query as { city?: string};
    if (!city) {
        res.status(400).json({ error: 'City query parameter is required' });
    } else {
        const result = await run(wjedroAgent, city);
        const messageItem = result.output.find(a => a.type === 'message');
        
        res.json({ 
            message: messageItem ? (messageItem as any).content[0].text : null, 
        })
    }
})

export default router;


