import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadSharp(entry) {
  if (entry !== undefined && !path.isAbsolute(entry)) throw new TypeError('Sharp entry must be an absolute path.');
  return (await import(entry === undefined ? 'sharp' : pathToFileURL(entry).href)).default;
}
