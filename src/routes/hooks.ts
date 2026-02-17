import { Response, Router, Request } from 'express'

const router = Router()

// POST /api/hooks/twilio - Twilio SIP
router.post('/twilio', async (_req: Request, res: Response) => {
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

// POST /api/hooks/twilio-gather - Twilio Speech-to-Text (no websocket, no Vosk)
// Point your Twilio Voice webhook to this endpoint if you only want the spoken text.
router.post('/twilio-gather', async (_req: Request, res: Response) => {
  res.set('Content-Type', 'text/xml')
  res.send(`
    <Response>
      <Gather input="speech" action="/api/hooks/twilio-gather-result" method="POST" speechTimeout="auto" language="de-DE">
        <Say language="de-DE">Sag bitte etwas.</Say>
      </Gather>
      <Say language="de-DE">Ich habe nichts gehoert.</Say>
      <Redirect method="POST">/api/hooks/twilio-gather</Redirect>
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
      <Redirect method="POST">/api/hooks/twilio-gather</Redirect>
    </Response>
  `)
})

export default router
