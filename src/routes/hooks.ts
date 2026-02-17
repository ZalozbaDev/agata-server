import { Response, Router, Request } from 'express'

const router = Router()

// POST /api/hooks/twilio - Twilio Voice webhook (logs spoken text via Twilio Speech Recognition)
router.post('/twilio', async (_req: Request, res: Response) => {
  res.set('Content-Type', 'text/xml')
  res.send(`
    <Response>
      <Gather input="speech" action="/api/hooks/twilio-gather-result" method="POST" speechTimeout="auto" language="de-DE">
        <Say language="de-DE">Sag bitte etwas.</Say>
      </Gather>
      <Say language="de-DE">Ich habe nichts gehoert.</Say>
      <Redirect method="POST">/api/hooks/twilio</Redirect>
    </Response>
  `)
})

// POST /api/hooks/twilio-stream - Twilio SIP (Media Streams websocket)
// Keep this if you still want Twilio -> websocket audio streaming.
router.post('/twilio-stream', async (_req: Request, res: Response) => {
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

// POST /api/hooks/twilio-gather-result - receives SpeechResult from Twilio
router.post('/twilio-gather-result', async (req: Request, res: Response) => {
  const speechResult = String(req.body?.SpeechResult ?? '').trim()
  const confidenceRaw = req.body?.Confidence
  const confidence =
    typeof confidenceRaw === 'string' || typeof confidenceRaw === 'number'
      ? Number(confidenceRaw)
      : null

  console.log('Twilio SpeechResult:', {
    callSid: req.body?.CallSid,
    from: req.body?.From,
    to: req.body?.To,
    confidence,
    text: speechResult,
  })

  res.set('Content-Type', 'text/xml')
  res.send(`
    <Response>
      <Say language="de-DE">Danke.</Say>
      <Redirect method="POST">/api/hooks/twilio</Redirect>
    </Response>
  `)
})

export default router
