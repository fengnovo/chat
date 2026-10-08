import { File } from 'expo-file-system';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { fetch as nativeFetch } from 'expo/fetch';
import type { UploadDependencies } from './upload';
export const nativeUpload: UploadDependencies = {
  read: (file) => new File(file.uri).bytes(),
  hash: async (bytes) =>
    Array.from(
      new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)),
    )
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
  put: nativeFetch as typeof fetch,
};
