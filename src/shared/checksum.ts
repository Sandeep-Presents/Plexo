/** A hash the finished file must have, as a download site lists it, to be published. */
export interface Checksum {
  algorithm: ChecksumAlgorithm
  /** Lowercase hex. */
  value: string
}

export type ChecksumAlgorithm = 'md5' | 'sha1' | 'sha256' | 'sha512'

export const CHECKSUM_LABEL: Record<ChecksumAlgorithm, string> = {
  md5: 'MD5',
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  sha512: 'SHA-512'
}

/** Hex digits per algorithm: how a pasted hash says which it is. */
const BY_LENGTH: Record<number, ChecksumAlgorithm> = {
  32: 'md5',
  40: 'sha1',
  64: 'sha256',
  128: 'sha512'
}

/** A pasted hash, with or without an "sha256:" style prefix or spaces; null when it's none of
 * the four. */
export function parseChecksum(text: string): Checksum | null {
  const value = text
    .trim()
    .replace(/^(md5|sha-?1|sha-?256|sha-?512)\s*[:=]?\s*/i, '')
    .replace(/\s+/g, '')
    .toLowerCase()
  const algorithm = /^[0-9a-f]+$/.test(value) ? BY_LENGTH[value.length] : undefined
  return algorithm ? { algorithm, value } : null
}
