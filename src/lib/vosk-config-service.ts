import WebSocket from 'ws'

export const VoskSendConfigService = {
  sendEOF: (webSocket: WebSocket | null) => {
    webSocket?.send(JSON.stringify({ eof: 1 }))
  },
  sendConfig: (
    webSocket: WebSocket | null,
    sampleRate: number,
    bufferSize: number,
  ) => {
    webSocket?.send(
      JSON.stringify({
        config: {
          sample_rate: sampleRate,
        },
      }),
    )
    webSocket?.send(
      JSON.stringify({
        config: { buffer_size: bufferSize },
      }),
    )
  },
  sendModel: (webSocket: WebSocket | null, model: string) => {
    webSocket?.send(
      JSON.stringify({
        config: { model },
      }),
    )
  },
  sendShowWords: (webSocket: WebSocket | null, showWords: boolean) => {
    webSocket?.send(
      JSON.stringify({
        config: { words: showWords },
      }),
    )
  },
  sendSampleFormat: (webSocket: WebSocket | null, sampleFormat: string) => {
    webSocket?.send(
      JSON.stringify({
        config: { sample_format: sampleFormat },
      }),
    )
  },
  sendChunkLength: (webSocket: WebSocket | null, chunkLength: number) => {
    webSocket?.send(
      JSON.stringify({
        config: { chunklen: chunkLength },
      }),
    )
  },
  sendClientTimestamp: (webSocket: WebSocket | null, milliseconds: number) => {
    webSocket?.send(
      JSON.stringify({
        ts: { s: milliseconds / 1000, ms: milliseconds },
      }),
    )
  },
}
