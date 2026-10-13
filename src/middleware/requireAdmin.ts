import { timingSafeEqual } from 'crypto'
import type { NextFunction, Request, Response } from 'express'

function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

export function readAdminToken(req: Request): string {
  const header = req.get('authorization') || ''
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  return (req.get('x-admin-token') || '').trim()
}

export function isAdminRequest(req: Request): boolean {
  const expected = process.env['ADMIN_TOKEN']?.trim()
  if (!expected) return false
  return tokensMatch(expected, readAdminToken(req))
}

/** The project has no user database. Admins authenticate with ADMIN_TOKEN. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env['ADMIN_TOKEN']?.trim()
  if (!expected) {
    res.status(503).json({
      error: 'Admin-Authentifizierung ist nicht konfiguriert (ADMIN_TOKEN).',
    })
    return
  }
  if (!tokensMatch(expected, readAdminToken(req))) {
    res.status(401).json({ error: 'Nicht autorisiert.' })
    return
  }
  next()
}
