import type { NextFunction, Request, Response } from 'express'

type Bucket = { count: number; resetAt: number }

const WINDOW_MS = 15 * 60 * 1000
const IP_LIMIT = 20
const buckets = new Map<string, Bucket>()

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown'
}

export function uploadRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now()
  if (buckets.size > 1000) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt < now) buckets.delete(key)
    }
  }

  const key = clientIp(req)
  let bucket = buckets.get(key)
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS }
    buckets.set(key, bucket)
  }
  bucket.count += 1
  if (bucket.count > IP_LIMIT) {
    res.status(429).json({
      error: 'Zu viele Uploads. Bitte später erneut versuchen.',
    })
    return
  }
  next()
}
