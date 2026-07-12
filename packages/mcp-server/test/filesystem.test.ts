import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { ToolError } from '../src/index.js';
import { makeSandbox, cleanup, responseText } from './helpers.js';

test('write_file then read_file roundtrip', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const file = path.join(dir, 'hello.txt');
    const written = await registry.execute('write_file', { path: file, content: 'hello world\nsecond line' });
    assert.match(responseText(written), /Written \d+ bytes/);

    const read = await registry.execute('read_file', { path: file });
    assert.match(responseText(read), /hello world/);
    assert.match(responseText(read), /second line/);
  } finally {
    await cleanup(dir);
  }
});

test('read_file respects offset and limit', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const file = path.join(dir, 'lines.txt');
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    await registry.execute('write_file', { path: file, content });
    const read = await registry.execute('read_file', { path: file, offset: 3, limit: 2 });
    const text = responseText(read);
    assert.match(text, /line3/);
    assert.match(text, /line4/);
    assert.doesNotMatch(text, /line5/);
  } finally {
    await cleanup(dir);
  }
});

test('read_file rejects binary files', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const file = path.join(dir, 'bin.dat');
    // Write a file dominated by null bytes.
    const binary = '\u0000'.repeat(100) + 'abc';
    await registry.execute('write_file', { path: file, content: binary });
    await assert.rejects(() => registry.execute('read_file', { path: file }), (err) => {
      assert.ok(err instanceof ToolError);
      return true;
    });
  } finally {
    await cleanup(dir);
  }
});

test('read_file on missing file throws FILE_NOT_FOUND', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    await assert.rejects(
      () => registry.execute('read_file', { path: path.join(dir, 'nope.txt') }),
      (err) => {
        assert.ok(err instanceof ToolError);
        assert.equal((err as ToolError).code, 'FILE_NOT_FOUND');
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});

test('create_directory then list_directory', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const sub = path.join(dir, 'a', 'b');
    const created = await registry.execute('create_directory', { path: sub });
    assert.match(responseText(created), /Created directory/);

    await registry.execute('write_file', { path: path.join(sub, 'f.txt'), content: 'x' });
    const listed = await registry.execute('list_directory', { path: sub });
    assert.match(responseText(listed), /f\.txt/);
  } finally {
    await cleanup(dir);
  }
});

test('get_file_info returns metadata', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const file = path.join(dir, 'info.txt');
    await registry.execute('write_file', { path: file, content: 'abcdef' });
    const info = await registry.execute('get_file_info', { path: file });
    const parsed = JSON.parse(responseText(info));
    assert.equal(parsed.isFile, true);
    assert.equal(parsed.isDirectory, false);
    assert.equal(parsed.size, 6);
  } finally {
    await cleanup(dir);
  }
});

test('edit_file exact match', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const file = path.join(dir, 'edit.txt');
    await registry.execute('write_file', { path: file, content: 'foo bar baz' });
    await registry.execute('edit_file', { path: file, old_string: 'bar', new_string: 'QUX' });
    const read = await registry.execute('read_file', { path: file });
    assert.match(responseText(read), /foo QUX baz/);
  } finally {
    await cleanup(dir);
  }
});

test('edit_file fuzzy match on whitespace differences', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const file = path.join(dir, 'fuzzy.txt');
    await registry.execute('write_file', { path: file, content: 'line1\n    indented line\nline3' });
    // old_string has different indentation than the file.
    await registry.execute('edit_file', {
      path: file,
      old_string: 'indented line',
      new_string: 'replaced line',
    });
    const read = await registry.execute('read_file', { path: file });
    assert.match(responseText(read), /replaced line/);
  } finally {
    await cleanup(dir);
  }
});

test('edit_file throws when multiple matches and not replace_all', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const file = path.join(dir, 'multi.txt');
    await registry.execute('write_file', { path: file, content: 'x x x' });
    await assert.rejects(
      () => registry.execute('edit_file', { path: file, old_string: 'x', new_string: 'y' }),
      (err) => {
        assert.ok(err instanceof ToolError);
        assert.equal((err as ToolError).code, 'INVALID_ARGUMENTS');
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});

test('edit_file replace_all replaces every occurrence', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const file = path.join(dir, 'all.txt');
    await registry.execute('write_file', { path: file, content: 'a a a' });
    await registry.execute('edit_file', { path: file, old_string: 'a', new_string: 'b', replace_all: true });
    const read = await registry.execute('read_file', { path: file });
    assert.match(responseText(read), /b b b/);
  } finally {
    await cleanup(dir);
  }
});

test('move_file relocates a file', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const src = path.join(dir, 'src.txt');
    const dst = path.join(dir, 'sub', 'dst.txt');
    await registry.execute('write_file', { path: src, content: 'movable' });
    await registry.execute('move_file', { source: src, destination: dst });
    const read = await registry.execute('read_file', { path: dst });
    assert.match(responseText(read), /movable/);
  } finally {
    await cleanup(dir);
  }
});

test('read_multiple_files returns combined content', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    const f1 = path.join(dir, 'm1.txt');
    const f2 = path.join(dir, 'm2.txt');
    await registry.execute('write_file', { path: f1, content: 'first-file' });
    await registry.execute('write_file', { path: f2, content: 'second-file' });
    const res = await registry.execute('read_multiple_files', { paths: [f1, f2] });
    const text = responseText(res);
    assert.match(text, /first-file/);
    assert.match(text, /second-file/);
  } finally {
    await cleanup(dir);
  }
});

test('search_files finds known content', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    await registry.execute('write_file', {
      path: path.join(dir, 'needle.txt'),
      content: 'nothing\nUNIQUEMARKER123\nnothing',
    });
    const res = await registry.execute('search_files', { pattern: 'UNIQUEMARKER123', path: dir });
    assert.match(responseText(res), /UNIQUEMARKER123/);
  } finally {
    await cleanup(dir);
  }
});

test('path outside allowed directory is blocked', async () => {
  const { dir, registry } = await makeSandbox();
  try {
    await assert.rejects(
      () => registry.execute('write_file', { path: '/etc/deckagent-should-not-write.txt', content: 'x' }),
      (err) => {
        assert.ok(err instanceof ToolError);
        assert.equal((err as ToolError).code, 'POLICY_BLOCKED');
        return true;
      },
    );
  } finally {
    await cleanup(dir);
  }
});
