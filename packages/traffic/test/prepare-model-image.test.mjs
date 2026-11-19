import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { prepareModelImage, observationPlan } from '../src/prepare-model-image.mjs';
import { inspectImage } from '../src/image-delivery-audit.mjs';

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; ++bit) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const content = Buffer.concat([Buffer.from(name), data]);
  const size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(content));
  return Buffer.concat([size, content, crc]);
}
function png(width, height, alpha = false) {
  const channels = alpha ? 4 : 3, pixels = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
    const p = y * (width * channels + 1) + 1 + x * channels;
    pixels[p] = x * 13 % 256; pixels[p + 1] = y * 17 % 256; pixels[p + 2] = (x + y) * 5 % 256;
    if (alpha) pixels[p + 3] = x % 2 ? 127 : 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function xmp(data) {
  const begin = data.indexOf(Buffer.from('<x:xmpmeta ')), end = data.indexOf(Buffer.from('</x:xmpmeta>'));
  assert.ok(begin >= 0 && end > begin);
  const xml = data.subarray(begin, end + '</x:xmpmeta>'.length).toString('utf8');
  if (data.toString('ascii', 0, 4) === 'RIFF') {
    assert.equal(data.readUInt32LE(4), data.length - 8);
    assert.equal(data.toString('ascii', 12, 16), 'VP8X');
    assert.ok(data[20] & 0x04, 'WebP advertises XMP metadata');
  } else {
    const identifier = 'http://ns.adobe.com/xap/1.0/\0';
    assert.ok(data.includes(Buffer.from(identifier)), 'JPEG advertises XMP metadata');
  }
  return xml;
}

test('one-shot PNG observations preserve sources, dimensions, alpha and provenance', async () => {
  const temporaryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Temp');
  const project = path.join(temporaryRoot, `image-observation-test-${randomUUID()}`);
  await fs.mkdir(project, { recursive: true });
  try {
    const source = path.join(project, '原图 & sample.png'), bytes = png(64, 32, true);
    await fs.writeFile(source, bytes); await fs.utimes(source, new Date(), new Date('2026-01-02T03:04:05Z'));
    const before = await fs.stat(source);
    const first = await prepareModelImage({ source, project });
    const second = await prepareModelImage({ source, project });
    assert.notEqual(first.path, second.path);
    assert.equal(path.dirname(first.path), path.join(await fs.realpath(project), 'Temp'));
    assert.match(path.basename(first.path), /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.webp$/);
    assert.equal(first.format, 'webp'); assert.equal(first.quality, 85); assert.equal(first.profileIndependent, true);
    const output = await fs.readFile(first.path), info = inspectImage(output), xml = xmp(output);
    assert.equal(info.compression, 'lossy'); assert.deepEqual([info.width, info.height], [64, 32]);
    assert.ok(xml.includes('原图 &amp; sample.png'));
    assert.ok(xml.includes(`ha:sourceCreatedAt="${before.birthtime.toISOString()}"`));
    assert.ok(xml.includes('ha:sourceModifiedAt="2026-01-02T03:04:05.000Z"'));
    assert.ok(xml.includes('ha:purpose="qualitative-model-observation"'));
    assert.deepEqual(await fs.readFile(source), bytes);
    assert.equal((await fs.stat(source)).mtimeMs, before.mtimeMs);
    const wide = path.join(project, 'wide.png'); await fs.writeFile(wide, png(2049, 4));
    await assert.rejects(prepareModelImage({ source: wide, project }), /verified --profile/);
    const jpeg = await prepareModelImage({ source: wide, project, profile: 'high' });
    const jpegData = await fs.readFile(jpeg.path); xmp(jpegData);
    assert.equal(jpeg.quality, 90); assert.equal(inspectImage(jpegData).format, 'jpeg');
    assert.deepEqual([inspectImage(jpegData).width, inspectImage(jpegData).height], [2049, 4]);
    const decoded = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([decoded.info.width, decoded.info.height, decoded.info.channels], [64, 32, 4]);
    assert.ok(decoded.data.some((value, index) => index % 4 === 3 && value === 127));
    const decodedJpeg = await sharp(jpegData).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([decodedJpeg.info.width, decodedJpeg.info.height, decodedJpeg.info.channels], [2049, 4, 3]);
    assert.ok((await sharp(output).metadata()).xmp.toString('utf8').includes('原图 &amp; sample.png'));
    assert.equal(observationPlan(2049, 4, 'original').format, 'webp');
    assert.equal((await fs.readdir(path.join(project, 'Temp'))).length, 3, 'one image per call, no metadata sidecars');
    const notPng = path.join(project, 'wrong.png'); await fs.writeFile(notPng, jpegData);
    await assert.rejects(prepareModelImage({ source: notPng, project }), /existing PNGs/);
    const transparentWide = path.join(project, 'transparent.png'); await fs.writeFile(transparentWide, png(2049, 4, true));
    await assert.rejects(prepareModelImage({ source: transparentWide, project, profile: 'high' }), /cannot preserve.*transparency/);
    const opaqueWide = path.join(project, 'opaque.png');
    const opaquePixels = Buffer.alloc(2049 * 4 * 4, 255);
    await sharp(opaquePixels, { raw: { width: 2049, height: 4, channels: 4 } }).png().toFile(opaqueWide);
    assert.equal((await prepareModelImage({ source: opaqueWide, project, profile: 'high' })).format, 'jpeg');
  } finally {
    const physicalProject = await fs.realpath(project);
    assert.equal(path.dirname(physicalProject), await fs.realpath(temporaryRoot));
    await fs.rm(physicalProject, { recursive: true });
  }
});
