export function mixDownToMono(channelData: Float32Array[]): Float32Array {
  if (channelData.length === 0) return new Float32Array(0)
  if (channelData.length === 1) return channelData[0]!

  const minLen = Math.min(...channelData.map(ch => ch.length))
  const out = new Float32Array(minLen)
  for (let i = 0; i < minLen; i++) {
    let sum = 0
    for (const ch of channelData) sum += ch[i] ?? 0
    out[i] = sum / channelData.length
  }
  return out
}

export function resampleLinear(
  input: Float32Array,
  inSampleRate: number,
  outSampleRate: number,
): Float32Array {
  if (inSampleRate === outSampleRate) return input
  if (input.length === 0) return input

  const ratio = outSampleRate / inSampleRate
  const outLen = Math.max(1, Math.round(input.length * ratio))
  const out = new Float32Array(outLen)

  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const s0 = input[Math.min(idx, input.length - 1)] ?? 0
    const s1 = input[Math.min(idx + 1, input.length - 1)] ?? 0
    out[i] = s0 + (s1 - s0) * frac
  }

  return out
}

export function float32ToPcm16le(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    const pcm16 = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767)
    out.writeInt16LE(pcm16, i * 2)
  }
  return out
}

export function downsample16kTo8kPickEveryOtherPcm16le(pcm16k: Buffer): Buffer {
  // pcm16k: PCM16LE @ 16000 Hz mono
  const samples = Math.floor(pcm16k.length / 2)
  const outSamples = Math.floor(samples / 2)
  const out = Buffer.alloc(outSamples * 2)

  for (let i = 0; i < outSamples; i++) {
    const s = pcm16k.readInt16LE(i * 4)
    out.writeInt16LE(s, i * 2)
  }

  return out
}
