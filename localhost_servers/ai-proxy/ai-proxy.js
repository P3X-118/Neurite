require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const app = express();

// Initialize API keys
let openaiApiKey = process.env.OPENAI_API_KEY;
let anthropicApiKey = process.env.ANTHROPIC_API_KEY;
let groqApiKey = process.env.GROQ_API_KEY;
let customApiKey = process.env.CUSTOM_API_KEY;

// Ollama Base URL (used when LOCALAI_BASE_URL is not set)
let ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/api/';

// LocalAI Base URL — when set, overrides the Ollama routes with LocalAI's OpenAI-compatible API
const localaiBaseUrl = process.env.LOCALAI_BASE_URL || null;

// LocalAI ("dex") enforces a bearer token — clients must send
// `Authorization: Bearer <LOCALAI_API_KEY>`. Without it every /models and
// /chat/completions call 401s. (Env was plumbed in but never read before.)
const localaiApiKey = process.env.LOCALAI_API_KEY || null;

// --- Single-flight queue for LocalAI (hal Jetson serves ONE model at a time) --
// Concurrent inference calls thrash the model backend (unload/reload -> timeouts,
// grpc-not-ready 500s). This box is the shared gateway, so serialization MUST
// live here (a global property of the single GPU), not per-caller. Only calls
// that hit LocalAI are serialized; external clouds (OpenAI/Anthropic/Groq) and
// quick metadata calls (tags) are not.
let localaiChain = Promise.resolve();
function runSerialized(task) {
    const run = localaiChain.then(task, task);
    // Keep the chain alive regardless of task outcome.
    localaiChain = run.then(() => {}, () => {});
    return run;
}

// Endpoint to receive API keys from the client-side JavaScript
app.post('/api-keys', (req, res) => {
    const { openaiApiKey: clientOpenaiApiKey, groqApiKey: clientGroqApiKey, anthropicApiKey: clientAnthropicApiKey, ollamaBaseUrl: clientOllamaBaseUrl } = req.body;

    if (clientOpenaiApiKey) openaiApiKey = clientOpenaiApiKey;
    if (clientGroqApiKey) groqApiKey = clientGroqApiKey;
    if (clientAnthropicApiKey) anthropicApiKey = clientAnthropicApiKey;
    if (clientOllamaBaseUrl) ollamaBaseUrl = clientOllamaBaseUrl;

    res.sendStatus(200);
});

function modifyRequestByApiType(apiType, headers, apiKey) {
    headers['Content-Type'] = 'application/json';
    // Only send auth when we actually have a key — avoids "Bearer null" (Ollama
    // ignored it, but it's wrong and some backends reject it).
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    if (apiType === 'anthropic') {
        headers['OpenAI-Version'] = '2020-10-01';
    }
}

// Rewrite one SSE line so reasoning-distill models (qwen3.5-9b-glm5.1-distill,
// gemma) render: they stream the answer in `delta.reasoning` with empty
// `delta.content`, and the Neurite client only reads content. Mirror the
// non-stream backfill onto the streaming path.
function transformSseLine(line) {
    if (!line.startsWith('data:')) return line; // comments/blank lines pass through
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return line;
    try {
        const obj = JSON.parse(payload);
        if (Array.isArray(obj.choices)) {
            obj.choices.forEach(c => {
                if (c.delta &&
                    (c.delta.content == null || c.delta.content === '') &&
                    c.delta.reasoning) {
                    c.delta.content = c.delta.reasoning;
                }
            });
        }
        return 'data: ' + JSON.stringify(obj);
    } catch (_) {
        return line; // not JSON we understand — pass through untouched
    }
}


const activeRequests = new Map();

function modifyResponseByApiType(apiType, response, res, stream, requestId, streamReasoning = false) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            if (requestId) {
                activeRequests.delete(requestId);
            }
        };

        if (stream && streamReasoning) {
            // Intercept SSE line-by-line to backfill reasoning -> content. Buffer
            // partial lines across chunk boundaries.
            if (!res.headersSent) {
                res.setHeader('Content-Type', response.headers['content-type'] || 'text/event-stream');
            }
            let buffer = '';
            response.data.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                let nl;
                while ((nl = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, nl);
                    buffer = buffer.slice(nl + 1);
                    res.write(transformSseLine(line) + '\n');
                }
            });
            response.data.on('end', () => {
                if (buffer) res.write(transformSseLine(buffer));
                res.end();
                cleanup();
                resolve();
            });
            response.data.on('error', (error) => {
                cleanup();
                reject(error);
            });
        } else if (stream) {
            response.data.pipe(res);
            response.data.on('end', () => {
                cleanup();
                resolve();
            });
            response.data.on('error', (error) => {
                cleanup();
                reject(error);
            });
        } else {
            // For thinking models (e.g. Qwen3), LocalAI puts CoT output in
            // response.data.choices[].message.reasoning and leaves content empty.
            // Fall back to reasoning so Neurite receives something usable.
            const data = response.data;
            if (data && Array.isArray(data.choices)) {
                data.choices.forEach(choice => {
                    if (choice.message &&
                        (choice.message.content === '' || choice.message.content == null) &&
                        choice.message.reasoning) {
                        choice.message.content = choice.message.reasoning;
                    }
                });
            }
            res.json(data);
            cleanup();
            resolve();
        }
    });
}

async function handleApiRequest(req, res, apiEndpoint, apiKey, apiType, additionalOptions = {}, proxyOpts = {}) {
    const { model, messages, max_tokens, temperature, stream, requestId } = req.body;
    const requestBody = {
        model,
        messages,
        max_tokens,
        temperature,
        stream,
        ...additionalOptions
    };
    const cancelToken = axios.CancelToken.source();

    if (requestId) {
        activeRequests.set(requestId, { cancelToken, res });
    }

    try {
        const headers = {};
        modifyRequestByApiType(apiType, headers, apiKey);

        const response = await axios.post(apiEndpoint, requestBody, {
            headers: headers,
            responseType: stream ? 'stream' : 'json',
            cancelToken: cancelToken.token
        });

        await modifyResponseByApiType(apiType, response, res, stream, requestId, proxyOpts.streamReasoning);
    } catch (error) {
        if (axios.isCancel(error)) {
            console.log('Request already canceled:', requestId);
        } else {
            console.error('Error calling API:', error);
            console.error('Error details:', error.response ? error.response.data : error.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to call API' });
            }
        }
    } finally {
        if (requestId) {
            activeRequests.delete(requestId);
        }
    }
}

app.post('/cancel', (req, res) => {
    const { requestId } = req.body;
    if (activeRequests.has(requestId)) {
        const { cancelToken, res: requestRes } = activeRequests.get(requestId);
        cancelToken.cancel('Request cancelled by client');
        if (!requestRes.headersSent) {
            requestRes.status(499).json({ error: 'Request canceled by the client' });
        }
        activeRequests.delete(requestId);
        res.status(200).json({ message: 'Request cancelled successfully' });
    } else {
        console.log('Request not found for cancellation:', requestId);
        res.status(404).json({ error: 'Request not found' });
    }
});

// Proxy routes
app.post('/openai', async (req, res) => {
    await handleApiRequest(req, res, 'https://api.openai.com/v1/chat/completions', openaiApiKey, 'openai');
});

app.post('/anthropic', async (req, res) => {
    await handleApiRequest(req, res, 'https://api.anthropic.com/v1/chat/completions', anthropicApiKey, 'anthropic');
});

app.post('/groq', async (req, res) => {
    await handleApiRequest(req, res, 'https://api.groq.com/openai/v1/chat/completions', groqApiKey, 'groq');
});

app.post('/ollama/chat', async (req, res) => {
    if (localaiBaseUrl) {
        // Serialize LocalAI inference (one model in flight on the Jetson) and
        // pass the bearer key + stream-reasoning backfill.
        await runSerialized(() => handleApiRequest(
            req, res, `${localaiBaseUrl}/chat/completions`, localaiApiKey, 'openai',
            {}, { streamReasoning: true }
        ));
    } else {
        await handleApiRequest(req, res, `${ollamaBaseUrl}chat`, null, 'ollama', { context: "" });
    }
});

app.post('/custom', async (req, res) => {
    const { apiEndpoint, apiKey: reqApiKey } = req.body;
    const effectiveApiKey = reqApiKey || customApiKey;
    await handleApiRequest(req, res, apiEndpoint, effectiveApiKey);
});

app.get('/ollama/tags', async (req, res) => {
    try {
        if (localaiBaseUrl) {
            const headers = localaiApiKey ? { Authorization: `Bearer ${localaiApiKey}` } : {};
            const response = await axios.get(`${localaiBaseUrl}/models`, { headers });
            const models = response.data.data.map(m => ({ name: m.id, model: m.id }));
            res.json({ models });
        } else {
            const response = await axios.get(`${ollamaBaseUrl}tags`);
            res.json(response.data);
        }
    } catch (error) {
        console.error('Error fetching model tags:', error);
        res.status(500).json({ error: 'Failed to fetch model tags' });
    }
});
app.get('/ollama/library', async (req, res) => {
    try {
        const response = await axios.get('https://ollama.com/library');
        const $ = cheerio.load(response.data);
        const models = [];
        $('li a[href^="/library/"]').each((index, element) => {
            const modelName = $(element).text().trim();
            models.push({ name: modelName });
        });
        res.json(models);
    } catch (error) {
        console.error('Error fetching Ollama library:', error);
        if (error.response && error.response.status === 500) {
            // Handle specific 500 Internal Server Error
            res.status(500).json({ error: 'Ollama library page is currently unavailable.' });
        } else {
            // Handle other errors
            res.status(500).json({ error: 'Failed to fetch Ollama library' });
        }
    }
});

app.post('/ollama/embeddings', async (req, res) => {
    const { model, prompt, options, keep_alive } = req.body;
    try {
        const response = await axios.post(`${ollamaBaseUrl}embeddings`, {
            model,
            prompt,
            options,
            keep_alive
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error generating embeddings:', error);
        res.status(500).json({ error: 'Failed to generate embeddings' });
    }
});

app.post('/ollama/pull', async (req, res) => {
    const { name, insecure, stream } = req.body;
    try {
        const response = await axios.post(`${ollamaBaseUrl}pull`, {
            name,
            insecure,
            stream
        }, {
            responseType: 'stream'
        });

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked'
        });

        response.data.on('data', (chunk) => {
            res.write(chunk);
        });

        response.data.on('end', () => {
            res.end();
        });
    } catch (error) {
        console.error('Error pulling model:', error);
        res.status(500).json({ error: 'Failed to pull model' });
    }
});

app.delete('/ollama/delete', async (req, res) => {
    const { name } = req.body;
    try {
        const response = await axios.delete(`${ollamaBaseUrl}delete`, {
            data: { name }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error deleting model:', error);
        res.status(500).json({ error: 'Failed to delete model' });
    }
});

app.post('/ollama/create', async (req, res) => {
    const { name, modelfile, stream, path } = req.body;
    try {
        const response = await axios.post(`${ollamaBaseUrl}create`, {
            name,
            modelfile,
            stream,
            path
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error creating model:', error);
        res.status(500).json({ error: 'Failed to create model' });
    }
});

app.post('/ollama/show', async (req, res) => {
    const { name } = req.body;
    try {
        const response = await axios.post(`${ollamaBaseUrl}show`, {
            name
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error showing model information:', error);
        res.status(500).json({ error: 'Failed to show model information' });
    }
});

// Check if a Blob Exists
app.head('/ollama/blobs/:digest', async (req, res) => {
    const { digest } = req.params;
    try {
        const response = await axios.head(`${ollamaBaseUrl}blobs/${digest}`);
        res.status(response.status).end();
    } catch (error) {
        console.error('Error checking blob:', error);
        res.status(404).json({ error: 'Blob not found' });
    }
});

// Create a Blob
app.post('/ollama/blobs/:digest', async (req, res) => {
    const { digest } = req.params;
    try {
        const response = await axios.post(`${ollamaBaseUrl}blobs/${digest}`, req.body, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        res.status(201).json(response.data);
    } catch (error) {
        console.error('Error creating blob:', error);
        res.status(400).json({ error: 'Failed to create blob' });
    }
});

app.post('/ollama/push', async (req, res) => {
    const { name, insecure, stream } = req.body;
    try {
        const response = await axios.post(`${ollamaBaseUrl}push`, {
            name,
            insecure,
            stream
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error pushing model:', error);
        res.status(500).json({ error: 'Failed to push model' });
    }
});

module.exports = app;