import { Router, Request, Response } from 'express'
import { Visitor } from '../models/Visitor'

const router = Router()

const ipLocks: Record<string, boolean> = {}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const visitors = await Visitor.find()
    res.json({ message: 'Visitor GET endpoint', visitors })
  } catch (error) {
    res.status(500).json({ message: 'Error fetching visitors', error })
  }
})

router.post('/', async (req: Request, res: Response) => {
  const { ipAddress } = req.body

  if (!ipAddress) {
    return res.status(400).json({ message: 'ipAddress is required' })
  }

  if (ipLocks[ipAddress]) {
    return res
      .status(429)
      .json({ message: 'Request for this IP is already being processed' })
  }

  ipLocks[ipAddress] = true
  try {
    const visitor = await Visitor.findOneAndUpdate(
      { ipAddress },
      { $push: { lastVisitedAt: new Date() } },
      { new: true }
    )
    if (!visitor) {
      const newVisitor = await new Visitor(req.body).save()
      ipLocks[ipAddress] = false
      return res
        .status(201)
        .json({ message: 'Visitor created', visitor: newVisitor })
    }
    ipLocks[ipAddress] = false
    return res.status(201).json({ message: 'Visitor created', visitor })
  } catch (error) {
    ipLocks[ipAddress] = false
    return res.status(500).json({ message: 'Error creating visitor', error })
  }
})

router.get('/count', async (_req: Request, res: Response) => {
  try {
    const visitors = await Visitor.find({}, 'lastVisitedAt')
    const totalCount = visitors.reduce((sum, visitor) => {
      return sum + (visitor.lastVisitedAt ? visitor.lastVisitedAt.length : 0)
    }, 0)
    res.json({ count: totalCount })
  } catch (error) {
    res.status(500).json({ message: 'Error counting visits', error })
  }
})

export default router
