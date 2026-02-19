import { Router, Request, Response } from 'express'

const router = Router()

router.get('/sip', (_req: Request, res: Response) => {
  res.json({
    status: 'OK',
    provider: 'sip-client',
    sipClientWsUrl: process.env['SIP_CLIENT_WS_URL'] ? 'configured' : 'missing',
  })
})

export default router
