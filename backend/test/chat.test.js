import './env.js';
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { repo } from '../src/db/index.js';
import { MAX_STEPS, conversationView, deleteConversation, listConversations, recentHistory, sendMessage } from '../src/agent/chat.js';
import { GOOD_LINKEDIN, freshDatabase, inWorkspace, seedBrand, setWorkspaceSettings } from './harness.js';
import { startServer } from './mockServer.js';
import { toClaudeMessages } from '../src/llm/anthropic.js';
import { toGeminiContents } from '../src/llm/gemini.js';

// The chat agent against a fake OpenAI-compatible AI that asks for tools, and the in-memory database.

let srv;
let bodies;
let answer; // (n, body) => message for the n-th chat call

const reply = (message) => ({ model: 'fake', choices: [{ message }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

before(async () => {
  srv = await startServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      bodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply(answer(bodies.length, body))));
    });
  });
});

after(() => srv.close());

beforeEach(() => {
  freshDatabase();
  bodies = [];
  answer = () => ({ content: 'Hello!' });
});

// The independent reviewer is switched off (review_provider "mcp" can't be called), so only the chat calls the fake AI.
const useFakeAi = () =>
  setWorkspaceSettings({
    ai_provider: 'openai_compat',
    openai_compat_base_url: `http://127.0.0.1:${srv.port}/v1`,
    openai_compat_model: 'chat-model',
    review_provider: 'mcp',
  });

test('the agent saves a draft with a tool, then answers; the chat shows the tool and the post', () =>
  inWorkspace(async () => {
    await seedBrand();
    await useFakeAi();
    answer = (n) =>
      n === 1
        ? { content: null, tool_calls: [toolCall('c1', 'create_post', { platform: 'linkedin', content: GOOD_LINKEDIN, brief: 'logo post' })] }
        : { content: 'Saved a LinkedIn draft. Approve it on the card.' };

    const result = await sendMessage({ message: 'Write a LinkedIn post about logos' });

    assert.equal(bodies.length, 2);
    const toolNames = bodies[0].tools.map((t) => t.function.name);
    assert.ok(toolNames.includes('create_post'));
    assert.ok(!toolNames.includes('schedule_post'), 'the chat can never schedule');
    assert.match(bodies[0].messages[0].content, /Acme Studio/, 'brand guide is in the system prompt');
    assert.ok(bodies[0].tools.every((t) => !('$schema' in t.function.parameters)));

    // The tool result went back to the AI under the same call id.
    const toolMsg = bodies[1].messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.tool_call_id, 'c1');
    assert.equal(JSON.parse(toolMsg.content).status, 'draft');

    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].status, 'draft');
    assert.equal(result.posts[0].content, GOOD_LINKEDIN);
    assert.deepEqual(result.messages.map((m) => m.role), ['user', 'assistant', 'assistant']);
    assert.deepEqual(result.messages[1].tools, [{ name: 'create_post', ok: true }]);
    assert.deepEqual(result.messages[1].post_ids, [result.posts[0].id]);
    assert.match(result.messages[2].text, /Saved a LinkedIn draft/);

    const usage = repo._usage.filter((u) => u.task === 'chat');
    assert.equal(usage.length, 2);
  }));

test('a conversation continues with its history, and reloads with the posts it touched', () =>
  inWorkspace(async () => {
    await seedBrand();
    await useFakeAi();
    answer = (n) =>
      n === 1 ? { content: null, tool_calls: [toolCall('c1', 'create_post', { platform: 'linkedin', content: GOOD_LINKEDIN })] } : { content: `answer ${n}` };

    const first = await sendMessage({ message: 'First message' });
    await sendMessage({ conversationId: first.conversation_id, message: 'Second message' });

    const sent = bodies.at(-1).messages.map((m) => m.role);
    assert.deepEqual(sent, ['system', 'user', 'assistant', 'tool', 'assistant', 'user']);

    const view = await conversationView(first.conversation_id);
    assert.equal(view.title, 'First message');
    assert.equal(view.messages.length, 5);
    assert.equal(view.posts.length, 1);
    assert.deepEqual((await listConversations()).map((c) => c.id), [first.conversation_id]);
  }));

test('a tool error goes back to the AI as an error result, and a hidden tool is refused', () =>
  inWorkspace(async () => {
    await seedBrand();
    await useFakeAi();
    const post = await repo.createPost({ platform: 'linkedin', content: GOOD_LINKEDIN, brief: 'x' });
    answer = (n) =>
      n === 1
        ? { content: null, tool_calls: [toolCall('a', 'schedule_post', { id: post.id }), toolCall('b', 'update_post', { id: 'nope', content: 'x' })] }
        : { content: 'Done.' };

    const result = await sendMessage({ message: 'Publish it now' });

    const results = bodies[1].messages.filter((m) => m.role === 'tool');
    assert.equal(results.length, 2);
    assert.match(results[0].content, /Unknown tool "schedule_post"/);
    assert.equal((await repo.getPost(post.id)).status, 'draft');
    assert.deepEqual(result.messages[1].tools.map((t) => t.ok), [false, false]);
    assert.equal(result.posts.length, 0);
  }));

test('the loop stops after the step limit with a note, and the history stays valid', () =>
  inWorkspace(async () => {
    await seedBrand();
    await useFakeAi();
    answer = (n) => ({ content: null, tool_calls: [toolCall(`c${n}`, 'list_posts', {})] });

    const result = await sendMessage({ message: 'Loop forever' });

    assert.equal(bodies.length, MAX_STEPS);
    assert.match(result.messages.at(-1).text, /too many steps/);
    const saved = await repo.getConversation(result.conversation_id);
    const calls = saved.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls);
    const answered = saved.messages.filter((m) => m.role === 'tool').flatMap((m) => m.results.map((r) => r.id));
    assert.deepEqual(answered, calls.map((c) => c.id), 'every tool call has a result');
  }));

test('an AI failure keeps the user message and returns a clear error', () =>
  inWorkspace(async () => {
    await seedBrand();
    await setWorkspaceSettings({ ai_provider: 'mcp' });
    await assert.rejects(sendMessage({ message: 'Hi' }), (e) => e.status === 400 && /Claude\.ai \(MCP\)/.test(e.message));
    const [conversation] = await listConversations();
    assert.deepEqual((await repo.getConversation(conversation.id)).messages, [{ role: 'user', content: 'Hi' }]);
  }));

test('conversations belong to one workspace', async () => {
  const mine = await inWorkspace(async () => {
    await seedBrand();
    await useFakeAi();
    return (await sendMessage({ message: 'Private' })).conversation_id;
  });
  await inWorkspace(async () => {
    await assert.rejects(conversationView(mine), (e) => e.status === 404);
    await assert.rejects(deleteConversation(mine), (e) => e.status === 404);
    assert.deepEqual(await listConversations(), []);
  }, 'ws-two');
  await inWorkspace(async () => {
    await deleteConversation(mine);
    assert.deepEqual(await listConversations(), []);
  });
});

test('empty and too long messages are refused before any AI call', () =>
  inWorkspace(async () => {
    await assert.rejects(sendMessage({ message: '  ' }), (e) => e.status === 400);
    await assert.rejects(sendMessage({ message: 'x'.repeat(4001) }), (e) => e.status === 400);
    assert.equal(bodies.length, 0);
  }));

// One conversation as each provider receives it: own turns go back unchanged, others are rebuilt.
const convo = (raw) => [
  { role: 'user', content: 'Write it' },
  { role: 'assistant', content: 'On it.', tool_calls: [{ id: 'toolu_1', name: 'list_posts', args: { limit: 2 } }], raw },
  { role: 'tool', results: [{ id: 'toolu_1', name: 'list_posts', content: '[]', is_error: false }, { id: 'toolu_2', name: 'x', content: 'bad', is_error: true }] },
];

test('Claude gets tool results in one user message, and its own raw turns unchanged', () => {
  const rebuilt = toClaudeMessages(convo({ provider: 'gemini', value: [{ text: 'gemini' }] }));
  assert.deepEqual(rebuilt[1], {
    role: 'assistant',
    content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'toolu_1', name: 'list_posts', input: { limit: 2 } }],
  });
  assert.deepEqual(rebuilt[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '[]' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: 'bad', is_error: true },
    ],
  });
  const own = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 'toolu_1', name: 'list_posts', input: {} }];
  assert.deepEqual(toClaudeMessages(convo({ provider: 'anthropic', value: own }))[1].content, own);
});

test('Gemini gets function responses, and its own parts (thought signatures) unchanged', () => {
  const own = [{ functionCall: { name: 'list_posts', args: {} }, thoughtSignature: 'sig' }];
  const contents = toGeminiContents(convo({ provider: 'gemini', value: own }));
  assert.deepEqual(contents[1], { role: 'model', parts: own });
  assert.deepEqual(contents[2].parts[0], { functionResponse: { id: 'toolu_1', name: 'list_posts', response: { result: '[]' } } });
  assert.deepEqual(contents[2].parts[1].functionResponse.response, { error: 'bad' });
  assert.deepEqual(toGeminiContents(convo(null))[1].parts, [{ text: 'On it.' }, { functionCall: { name: 'list_posts', args: { limit: 2 } } }]);
});

test('history sent to the AI starts at a user message', () => {
  const msgs = [
    { role: 'user', content: '1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a' }] },
    { role: 'tool', results: [{ id: 'a' }] },
    { role: 'assistant', content: 'x' },
    { role: 'user', content: '2' },
    { role: 'assistant', content: 'y' },
  ];
  assert.deepEqual(recentHistory(msgs, 4).map((m) => m.content ?? m.role), ['2', 'y']);
  assert.equal(recentHistory(msgs, 10).length, 6);
});
