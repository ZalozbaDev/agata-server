import { Response, Router, Request } from 'express'

const router = Router()

// POST /api/hooks/twilio - Twilio SIP
router.post('/twilio', async (req: Request, res: Response) => {
  const streamUrl = 'wss://agata.fs-coding-api.com/api/hooks/twilio-websocket'

  res.set('Content-Type', 'text/xml')
  res.send(`
    <Response>
      <Connect>
        <Stream url="${streamUrl}" />
      </Connect>
    </Response>
  `)
})

export default router
