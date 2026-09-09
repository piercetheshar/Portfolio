process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'mock-key';
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: 'Mock response' }] } }]
  }),
  text: async () => 'Mock response'
});
import handler from './api/hana.js';

function createMockReqRes({ method = 'POST', headers = {}, body = null, ip = '127.0.0.1' } = {}) {
  const req = {
    method,
    headers: {
      'x-forwarded-for': ip,
      ...headers,
    },
    body,
    socket: { remoteAddress: ip }
  };

  let statusCode = 200;
  let responseHeaders = {};
  let responseBody = null;
  let ended = false;

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    setHeader(name, value) {
      responseHeaders[name.toLowerCase()] = value;
      return res;
    },
    json(data) {
      responseBody = data;
      ended = true;
      return res;
    },
    end(data) {
      if (data) responseBody = data;
      ended = true;
      return res;
    },
    _getData() {
      return { statusCode, responseHeaders, responseBody, ended };
    }
  };

  return { req, res };
}

async function runTests() {
  console.log('=== Starting Automated Tests for api/hana.js ===\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, name) {
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
      failed++;
    }
  }

  // Test 1: OPTIONS Preflight
  {
    const { req, res } = createMockReqRes({
      method: 'OPTIONS',
      headers: { origin: 'https://sharvarimayekar.com' }
    });
    await handler(req, res);
    const result = res._getData();
    assert(result.statusCode === 204, 'OPTIONS preflight returns 204');
    assert(result.responseHeaders['access-control-allow-origin'] === 'https://sharvarimayekar.com', 'OPTIONS sets Access-Control-Allow-Origin');
    assert(result.responseHeaders['access-control-allow-methods'] === 'POST, OPTIONS', 'OPTIONS sets allowed methods');
  }

  // Test 2: Disallowed Method (GET)
  {
    const { req, res } = createMockReqRes({ method: 'GET' });
    await handler(req, res);
    const result = res._getData();
    assert(result.statusCode === 405, 'GET returns 405 Method Not Allowed');
    assert(result.responseBody?.error?.includes('POST'), 'GET returns helpful error message');
  }

  // Test 3: Missing Body
  {
    const { req, res } = createMockReqRes({ method: 'POST', body: null });
    await handler(req, res);
    const result = res._getData();
    assert(result.statusCode === 400, 'Missing body returns 400 Bad Request');
  }

  // Test 4: Malformed JSON string body
  {
    const { req, res } = createMockReqRes({ method: 'POST', body: '{ malformed json' });
    await handler(req, res);
    const result = res._getData();
    assert(result.statusCode === 400, 'Malformed JSON returns 400 Bad Request');
  }

  // Test 5: Missing or non-array messages
  {
    const { req, res } = createMockReqRes({ method: 'POST', body: { messages: 'not an array' } });
    await handler(req, res);
    const result = res._getData();
    assert(result.statusCode === 400, 'Non-array messages field returns 400');
  }

  // Test 6: Empty messages array
  {
    const { req, res } = createMockReqRes({ method: 'POST', body: { messages: [] } });
    await handler(req, res);
    const result = res._getData();
    assert(result.statusCode === 400, 'Empty messages array returns 400');
  }

  // Test 7: Exceeds 30 messages
  {
    const messages = Array.from({ length: 31 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`
    }));
    const { req, res } = createMockReqRes({ method: 'POST', body: { messages } });
    await handler(req, res);
    const result = res._getData();
    assert(result.statusCode === 400, '> 30 messages returns 400 Bad Request');
    assert(result.responseBody?.error?.includes('30 messages'), 'Message states 30 messages limit');
  }

  // Test 8: Invalid message role
  {
    const { req, res } = createMockReqRes({
      method: 'POST',
      body: { messages: [{ role: 'system', content: 'hello' }] }
    });
    await handler(req, res);
    const result = res._getData();
    assert(result.statusCode === 400, 'Invalid message role returns 400');
  }

  // Test 9: Empty content
  {
    const { req, res } = createMockReqRes({
      method: 'POST',
      body: { messages: [{ role: 'user', content: '   ' }] }
    });
    await handler(req, res);
    const result = res._getData();
    assert(result.statusCode === 400, 'Empty message content returns 400');
  }

  // Test 10: Missing API keys returns 500
  {
    const origAnthropic = process.env.ANTHROPIC_API_KEY;
    const origGemini = process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const { req, res } = createMockReqRes({
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'Hello' }] }
    });
    await handler(req, res);
    const result = res._getData();
    assert(result.statusCode === 500, 'Missing AI API keys returns 500');
    assert(result.responseBody?.error?.includes('AI API key is not configured'), 'Clean error message on missing API key');
    if (origAnthropic) process.env.ANTHROPIC_API_KEY = origAnthropic;
    if (origGemini) process.env.GEMINI_API_KEY = origGemini;
  }

  // Test 11: Rate Limiting (> 15 requests from same IP)
  {
    const testIp = '192.168.1.99';
    let limited = false;
    for (let i = 0; i < 18; i++) {
      const { req, res } = createMockReqRes({
        method: 'POST',
        ip: testIp,
        body: { messages: [{ role: 'user', content: `Ping ${i}` }] }
      });
      await handler(req, res);
      const result = res._getData();
      if (result.statusCode === 429) {
        limited = true;
        assert(result.responseHeaders['retry-after'] === '60', 'Rate limit sets Retry-After header');
        break;
      }
    }
    assert(limited, 'Rate limiter triggers 429 after 15 requests from same IP');
  }

  // Test 12: CORS Origin Restriction with ALLOWED_ORIGIN env var
  {
    process.env.ALLOWED_ORIGIN = 'https://sharvarimayekar.com, https://sharvari-portfolio.vercel.app';
    
    // Allowed origin
    {
      const { req, res } = createMockReqRes({
        method: 'OPTIONS',
        headers: { origin: 'https://sharvarimayekar.com' }
      });
      await handler(req, res);
      const result = res._getData();
      assert(result.statusCode === 204, 'Configured domain allowed');
      assert(result.responseHeaders['access-control-allow-origin'] === 'https://sharvarimayekar.com', 'CORS origin reflected for allowed domain');
    }

    // Disallowed origin
    {
      const { req, res } = createMockReqRes({
        method: 'POST',
        headers: { origin: 'https://malicious-site.com' },
        body: { messages: [{ role: 'user', content: 'Hello' }] }
      });
      await handler(req, res);
      const result = res._getData();
      assert(result.statusCode === 403, 'Disallowed origin returns 403 Forbidden');
    }

    // Localhost allowed in development
    {
      const { req, res } = createMockReqRes({
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:3000' }
      });
      await handler(req, res);
      const result = res._getData();
      assert(result.statusCode === 204, 'Localhost allowed during development');
    }

    delete process.env.ALLOWED_ORIGIN;
  }

  console.log(`\n=== Test Results: ${passed} Passed, ${failed} Failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
