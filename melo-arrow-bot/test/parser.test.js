const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeliveryParser } = require('../src/parser');

const parse = createDeliveryParser(null);

function fakeMessage(description) {
  return {
    content: '',
    embeds: [{ description, footer: { text: 'Powered by MinecraftBot.com' }, fields: [] }],
  };
}

test('parses the provided MinecraftBot embed format', () => {
  const result = parse(fakeMessage('handcrema delivered you 311 Arrows'));
  assert.equal(result.ign, 'handcrema');
  assert.equal(result.amount, 311n);
});

test('parses singular Arrow and usernames that look like words', () => {
  const result = parse(fakeMessage('Players delivered you 1 Arrow'));
  assert.equal(result.ign, 'Players');
  assert.equal(result.amount, 1n);
});

test('parses comma-separated amounts', () => {
  const result = parse(fakeMessage('DonutGuy delivered you 12,500 Arrows'));
  assert.equal(result.ign, 'DonutGuy');
  assert.equal(result.amount, 12_500n);
});

test('parses the screenshot variant without an Arrow suffix', () => {
  const result = parse(fakeMessage('Players delivered you 934'));
  assert.equal(result.ign, 'Players');
  assert.equal(result.amount, 934n);
});
