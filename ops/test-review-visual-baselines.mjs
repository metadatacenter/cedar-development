import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';

import {
  compareImages,
  cropRegion,
  decodePng,
  encodePng,
  findRegions,
  formatReport,
  reviewRepository,
  sharedTransitions,
} from './review-visual-baselines.mjs';

function image(width, height, [r, g, b] = [255, 255, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) data.set([r, g, b, 255], p * 4);
  return { width, height, data };
}

function paint(img, x0, y0, x1, y1, [r, g, b]) {
  const copy = { ...img, data: Uint8Array.from(img.data) };
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) copy.data.set([r, g, b, 255], (y * img.width + x) * 4);
  return copy;
}

/** A PNG in any 8-bit colour type, each row written with the given filter type. */
function rawPng(width, height, colourType, samples, { palette, filter = 0 } = {}) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const value = samples[y * stride + i];
      const left = i >= channels ? samples[y * stride + i - channels] : 0;
      const up = y > 0 ? samples[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? samples[(y - 1) * stride + i - channels] : 0;
      const estimate = left + up - upLeft;
      const paeth = [left, up, upLeft].reduce((best, c) => (Math.abs(estimate - c) < Math.abs(estimate - best) ? c : best));
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter];
      raw[y * (stride + 1) + 1 + i] = (value - predictor) & 0xff;
    }
  }
  const chunk = (type, body) => {
    const named = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(named));
    return Buffer.concat([length, named, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colourType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(palette ? [chunk('PLTE', Buffer.from(palette))] : []),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('a PNG this tool writes reads back pixel for pixel', () => {
  const original = paint(image(7, 5, [10, 20, 30]), 2, 1, 4, 3, [200, 100, 50]);
  const decoded = decodePng(encodePng(original));
  assert.equal(decoded.width, 7);
  assert.equal(decoded.height, 5);
  assert.deepEqual(decoded.data, original.data);
});

test('every row filter is undone, whichever colour type the file uses', () => {
  const rgb = [];
  for (let p = 0; p < 12; p++) rgb.push((p * 37) % 256, (p * 91) % 256, (p * 13) % 256);
  for (const filter of [0, 1, 2, 3, 4]) {
    const decoded = decodePng(rawPng(4, 3, 2, rgb, { filter }));
    for (let p = 0; p < 12; p++) {
      assert.deepEqual([...decoded.data.subarray(p * 4, p * 4 + 4)], [...rgb.slice(p * 3, p * 3 + 3), 255],
        `filter ${filter}, pixel ${p}`);
    }
  }
  const grey = decodePng(rawPng(2, 1, 4, [90, 128, 200, 255], { filter: 1 }));
  assert.deepEqual([...grey.data], [90, 90, 90, 128, 200, 200, 200, 255]);
  const indexed = decodePng(rawPng(2, 1, 3, [1, 0], { palette: [0, 0, 0, 15, 118, 134] }));
  assert.deepEqual([...indexed.data], [15, 118, 134, 255, 0, 0, 0, 255]);
});

test('a file that is not an 8-bit, non-interlaced PNG is refused by name', () => {
  assert.throws(() => decodePng(Buffer.from('GIF89a')), /not a PNG/);
  const sixteenBit = rawPng(1, 1, 0, [0]);
  sixteenBit[24] = 16;
  assert.throws(() => decodePng(sixteenBit), /unsupported PNG: bit depth 16/);
});

test('a grey outline drawn darker is a tone shift and nothing else', () => {
  const before = paint(image(40, 20), 5, 5, 30, 5, [158, 158, 158]);
  const after = paint(image(40, 20), 5, 5, 30, 5, [143, 143, 143]);
  const result = compareImages(before, after);
  assert.equal(result.kind, 'darker');
  assert.equal(result.changed, 26);
  assert.equal(result.colour, 0);
  assert.deepEqual(result.regions, [{ x: 5, y: 5, width: 26, height: 1, pixels: 26, colour: 0 }]);
  assert.deepEqual([...result.transitions], [['#9e9e9e → #8f8f8f', 26]]);
});

test('new content, a hue change or tone moving both ways is mixed', () => {
  const base = image(20, 20);
  assert.equal(compareImages(base, paint(base, 2, 2, 4, 4, [15, 118, 134])).kind, 'mixed');
  assert.equal(compareImages(base, paint(base, 2, 2, 4, 4, [0, 0, 0])).kind, 'mixed',
    'black text on white is far beyond a tone shift');
  const grey = paint(base, 0, 0, 19, 0, [128, 128, 128]);
  const both = paint(paint(grey, 0, 0, 9, 0, [120, 120, 120]), 10, 0, 19, 0, [136, 136, 136]);
  const result = compareImages(grey, both);
  assert.equal(result.kind, 'mixed');
  assert.equal(result.darker, 10);
  assert.equal(result.lighter, 10);
});

test('identical pixels in a rewritten file and a changed size are told apart', () => {
  const base = image(8, 8);
  assert.equal(compareImages(base, image(8, 8)).kind, 'same-pixels');
  assert.deepEqual(compareImages(base, image(8, 9)), { kind: 'resized', before: [8, 8], after: [8, 9] });
});

test('changed pixels a few apart form one region, distant ones another', () => {
  const width = 50;
  const mask = new Uint8Array(width * 10);
  for (const x of [1, 4, 8]) mask[2 * width + x] = 1;
  for (const x of [30, 31]) mask[7 * width + x] = 1;
  assert.deepEqual(findRegions(mask, width, 10), [
    { x: 1, y: 2, width: 8, height: 1, pixels: 3, colour: 0 },
    { x: 30, y: 7, width: 2, height: 1, pixels: 2, colour: 0 },
  ]);
  assert.equal(findRegions(mask, width, 10, 3).length, 3, 'a smaller gap splits the first region');
});

test('a small colour change is listed before a larger tone shift', () => {
  const before = paint(image(60, 30), 2, 2, 57, 2, [158, 158, 158]);
  const after = paint(paint(image(60, 30), 2, 2, 57, 2, [143, 143, 143]), 40, 20, 40, 20, [200, 0, 0]);
  const { kind, regions } = compareImages(before, after);
  assert.equal(kind, 'mixed');
  assert.deepEqual(regions.map(r => [r.x, r.y, r.pixels, r.colour]), [[40, 20, 1, 1], [2, 2, 56, 0]]);
});

test('a crop shows the region before, after and with its changed pixels marked', () => {
  const before = image(10, 10);
  const after = paint(before, 4, 4, 4, 4, [0, 0, 0]);
  const { mask, regions } = compareImages(before, after);
  const crop = cropRegion(before, after, mask, regions[0], { padding: 1, context: 0, scale: 2 });
  assert.equal(crop.height, 6);
  assert.equal(crop.width, 6 * 3 + 8);
  const pixel = (x, y) => [...crop.data.subarray((y * crop.width + x) * 4, (y * crop.width + x) * 4 + 3)];
  assert.deepEqual(pixel(2, 2), [255, 255, 255], 'the base rendering is unchanged');
  assert.deepEqual(pixel(6 + 4 + 2, 2), [0, 0, 0], 'the new rendering shows the change');
  assert.deepEqual(pixel(2 * (6 + 4) + 2, 2), [255, 0, 255], 'the mask marks it');
  const widened = cropRegion(before, after, mask, regions[0], { scale: 1 });
  assert.equal(widened.height, 10, 'a small region is widened to the context, within the image');
});

test('a repository review compares the working tree with the base revision', t => {
  const repository = mkdtempSync(join(tmpdir(), 'baseline-review-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.org');
  git('config', 'user.name', 'test');
  const outline = colour => paint(image(30, 30), 3, 3, 26, 3, colour);
  writeFileSync(join(repository, 'field.png'), encodePng(outline([158, 158, 158])));
  writeFileSync(join(repository, 'chip.png'), encodePng(outline([158, 158, 158])));
  writeFileSync(join(repository, 'menu.png'), encodePng(image(30, 30)));
  writeFileSync(join(repository, 'gone.png'), encodePng(image(4, 4)));
  writeFileSync(join(repository, 'notes.txt'), 'not a baseline');
  git('add', '.');
  git('commit', '-q', '-m', 'baselines');

  writeFileSync(join(repository, 'field.png'), encodePng(outline([143, 143, 143])));
  writeFileSync(join(repository, 'chip.png'), encodePng(outline([143, 143, 143])));
  writeFileSync(join(repository, 'menu.png'), encodePng(paint(image(30, 30), 10, 10, 12, 12, [200, 0, 0])));
  writeFileSync(join(repository, 'new.png'), encodePng(image(4, 4)));
  writeFileSync(join(repository, 'notes.txt'), 'changed, and still not a baseline');
  rmSync(join(repository, 'gone.png'));

  const crops = join(repository, 'crops');
  const reviews = reviewRepository(repository, { crops });
  assert.deepEqual(reviews.map(r => [r.path, r.kind]), [
    ['chip.png', 'darker'], ['field.png', 'darker'], ['gone.png', 'removed'], ['menu.png', 'mixed'], ['new.png', 'added'],
  ]);
  assert.ok(existsSync(join(crops, 'menu--1.png')));
  assert.deepEqual(sharedTransitions(reviews), [{ transition: '#9e9e9e → #8f8f8f', pixels: 48, baselines: 2 }]);

  const report = formatReport(repository, 'HEAD', reviews);
  assert.match(report, /^5 changed baselines in .* against HEAD\n {2}1 added, 1 removed, 1 mixed, 2 darker$/m);
  assert.match(report, /#9e9e9e → #8f8f8f {2}48 px in 2 baselines/);
  assert.match(report, /Mixed changes \(review these first\):\n {2}menu\.png {2}9 px \(1\.00%\); colour changes in 1 of 1 region, most in 3×3 at 10,10; darker 0, lighter 0, colour 9/);
  assert.ok(report.indexOf('menu.png') < report.indexOf('chip.png'), 'mixed changes come before tone shifts');

  assert.deepEqual(reviewRepository(repository, { paths: ['field.png'] }).map(r => r.path), ['field.png']);
});
