import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import type { TerminalArtifactAccessOptions, TerminalArtifactFileStat } from './types'

export async function writeSshTerminalArtifact(
  mux: SshChannelMultiplexer,
  filePath: string,
  content: string,
  options: TerminalArtifactAccessOptions
): Promise<TerminalArtifactFileStat> {
  let result: { stat?: TerminalArtifactFileStat }
  try {
    result = (await mux.request('fs.writeTerminalArtifact', {
      filePath,
      content,
      expectedRealPath: options.expectedRealPath,
      expectedStatIdentity: options.expectedStatIdentity,
      expectedContentDigest: options.expectedContentDigest,
      maxBytes: options.maxBytes
    })) as { stat?: TerminalArtifactFileStat }
  } catch (err) {
    if (isMethodNotFoundError(err)) {
      throw new Error(
        'Remote terminal artifact access is unavailable. Reconnect the SSH target before retrying.'
      )
    }
    throw err
  }
  if (!result.stat) {
    throw new Error('terminal_file_grant_stale')
  }
  return result.stat
}
