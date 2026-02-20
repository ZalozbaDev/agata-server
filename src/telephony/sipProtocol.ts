const MAGIC = Buffer.from('AGTA', 'ascii')
const VERSION = 1

function envFlag(name: string, def = false): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase()
  if (!v) return def
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function hexPreview(buf: Buffer, maxBytes = 32): string {
  const n = Math.min(buf.length, maxBytes)
  return buf.subarray(0, n).toString('hex')
}

export type SipAudioFrame = {
  callId: string
  audioPcm16le: Buffer
}

export function encodeSipAudioFrame(
  callId: string,
  audioPcm16le: Buffer,
): Buffer {
  const callIdBytes = Buffer.from(callId, 'utf8')
  if (callIdBytes.length > 0xffff) {
    throw new Error('callId too long')
  }

  const header = Buffer.alloc(4 + 1 + 2)
  MAGIC.copy(header, 0)
  header.writeUInt8(VERSION, 4)
  header.writeUInt16LE(callIdBytes.length, 5)

  return Buffer.concat([header, callIdBytes, audioPcm16le])
}

export function decodeSipAudioFrame(buf: Buffer): SipAudioFrame | null {
  const debug = envFlag('SIP_PROTOCOL_DEBUG', false)
  if (debug) {
    // eslint-disable-next-line no-console
    console.log(`[SIP/PROTO] rx bytes=${buf.length}  hex=${hexPreview(buf)}`)
  }

  if (buf.length < 7) {
    if (debug) {
      // eslint-disable-next-line no-console
      console.warn('[SIP/PROTO] drop: too short')
    }
    return null
  }
  if (!buf.subarray(0, 4).equals(MAGIC)) {
    if (debug) {
      // eslint-disable-next-line no-console
      console.warn('[SIP/PROTO] drop: bad magic')
    }
    return null
  }

  const version = buf.readUInt8(4)
  if (version !== VERSION) {
    if (debug) {
      // eslint-disable-next-line no-console
      console.warn(`[SIP/PROTO] drop: bad version=${version}`)
    }
    return null
  }

  const callIdLen = buf.readUInt16LE(5)
  const callIdStart = 7
  const callIdEnd = callIdStart + callIdLen
  if (callIdEnd > buf.length) {
    if (debug) {
      // eslint-disable-next-line no-console
      console.warn(
        `[SIP/PROTO] drop: callIdLen=${callIdLen} exceeds buf (needEnd=${callIdEnd} have=${buf.length})`,
      )
    }
    return null
  }

  const callId = buf.subarray(callIdStart, callIdEnd).toString('utf8')
  const audioPcm16le = buf.subarray(callIdEnd)
  if (debug) {
    // eslint-disable-next-line no-console
    console.log(
      `[SIP/PROTO] ok callIdLen=${callIdLen} callId=${JSON.stringify(callId)} audioBytes=${audioPcm16le.length}`,
    )
  }
  return { callId, audioPcm16le }
}
