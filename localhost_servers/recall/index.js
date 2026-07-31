// Recall sub-server — Neurite's vector store, backed by the estate LocalRecall
// (recall.sgc.ai) instead of the retired webscrape sqlite VDB. The browser sends
// TEXT only; LocalRecall embeds server-side, so no vectors ever live client-side
// and the embed-model choice is invisible to the frontend (no dimension coupling).
//
// Mounted by start_servers.js at /recall. Estate queue discipline: every LocalRecall
// call (each may hit the embedding model on the Jetson) runs through ONE in-process
// serial queue with a 120s ceiling (cold model loads are 36–46s and normal).
//
// Auth: LOCALRECALL_API_KEY from the environment or from ./.recall-env (git-ignored,
// lives in the bind-mounted source tree so no container-recreate is needed to rotate).
//
// A small ./registry.json maps LocalRecall doc ids -> {key, chunk} so the original
// display keys (titles/URLs, significant slashes) survive the doc-id slugging.

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- env (process env wins; .recall-env fills gaps) -------------------------
function loadDotEnv() {
    try {
        const text = fs.readFileSync(path.join(__dirname, '.recall-env'), 'utf8');
        for (const line of text.split('\n')) {
            const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
            if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
        }
    } catch { /* no file — env only */ }
}
loadDotEnv();

const RECALL_URL = (process.env.LOCALRECALL_URL || 'https://recall.sgc.ai').replace(/\/+$/, '');
const API_KEY = process.env.LOCALRECALL_API_KEY || '';
const COLLECTION = process.env.RECALL_COLLECTION || 'neurite-vdb';
const TIMEOUT_MS = Number(process.env.RECALL_TIMEOUT_MS || 120000);

const configured = () => Boolean(API_KEY);
const authHeaders = () => ({ authorization: `Bearer ${API_KEY}` });

// --- serial queue (one LocalRecall call in flight — hal discipline) ---------
let chain = Promise.resolve();
function serialized(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
}

// --- registry: docId -> {key, chunk} ----------------------------------------
const REGISTRY_PATH = path.join(__dirname, 'registry.json');
function readRegistry() {
    try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); }
    catch { return { docs: {} }; }
}
function writeRegistry(reg) {
    const tmp = REGISTRY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 1));
    fs.renameSync(tmp, REGISTRY_PATH);
}
const slug = (s) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
const docIdFor = (key, i) => `nv-${slug(key)}-c${i}`;

// --- LocalRecall ops (all serialized, all best-effort) ----------------------
let collectionEnsured = null;
function ensureCollection() {
    collectionEnsured ??= serialized(async () => {
        const res = await fetch(`${RECALL_URL}/api/collections`, {
            method: 'POST',
            headers: { ...authHeaders(), 'content-type': 'application/json' },
            body: JSON.stringify({ name: COLLECTION }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok && res.status !== 409) throw new Error(`ensure collection: HTTP ${res.status}`);
        return true;
    }).catch((err) => { collectionEnsured = null; throw err; });
    return collectionEnsured;
}

async function uploadDoc(docId, text) {
    return serialized(async () => {
        const form = new FormData();
        form.append('file', new Blob([text], { type: 'text/plain' }), `${docId}.txt`);
        const res = await fetch(`${RECALL_URL}/api/collections/${encodeURIComponent(COLLECTION)}/upload`, {
            method: 'POST',
            headers: authHeaders(),
            body: form,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`upload ${docId}: HTTP ${res.status}`);
        return true;
    });
}

async function searchDocs(query, k) {
    const attempt = (n) => serialized(async () => {
        const res = await fetch(`${RECALL_URL}/api/collections/${encodeURIComponent(COLLECTION)}/search`, {
            method: 'POST',
            headers: { ...authHeaders(), 'content-type': 'application/json' },
            body: JSON.stringify({ query, max_results: n }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`search: HTTP ${res.status}`);
        const j = await res.json();
        return j?.data?.results ?? [];
    });
    try { return await attempt(k); }
    catch {
        // chromem 500s when max_results exceeds a tiny collection's doc count.
        if (k > 1) { try { return await attempt(1); } catch { return []; } }
        return [];
    }
}

async function deleteDoc(docId) {
    return serialized(async () => {
        const res = await fetch(`${RECALL_URL}/api/collections/${encodeURIComponent(COLLECTION)}/entry/delete`, {
            method: 'DELETE',
            headers: { ...authHeaders(), 'content-type': 'application/json' },
            body: JSON.stringify({ entry: `${docId}.txt` }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        return res.ok;
    });
}

// --- chunk headers: identity travels inside the text ------------------------
const header = (key, i) => `[KEY::${key}::CHUNK::${i}]`;
function parseHeader(content) {
    const m = content.match(/^\[KEY::([\s\S]*?)::CHUNK::(\d+)\]\n?/);
    if (!m) return { key: null, chunk: null, text: content };
    return { key: m[1], chunk: Number(m[2]), text: content.slice(m[0].length) };
}

// --- routes -----------------------------------------------------------------
const app = express();

app.use((req, res, next) => {
    if (!configured()) {
        return res.status(503).json({ error: 'LocalRecall not configured (LOCALRECALL_API_KEY missing)' });
    }
    next();
});

// All stored keys (original display keys, via the registry).
app.get('/keys', (req, res) => {
    const reg = readRegistry();
    const keys = [...new Set(Object.values(reg.docs).map((d) => d.key))];
    res.json(keys);
});

// Store a key's text chunks. Body: {key, chunks: [string]}. Replaces the key's
// previous chunks (delete-then-store), mirroring the old INSERT OR REPLACE.
app.post('/store', async (req, res) => {
    const { key, chunks } = req.body || {};
    if (!key || !Array.isArray(chunks) || chunks.length === 0) {
        return res.status(400).json({ error: 'expected {key, chunks[]}' });
    }
    try {
        await ensureCollection();
        const reg = readRegistry();
        // Drop any previous docs for this key (stale chunk counts).
        const stale = Object.entries(reg.docs).filter(([, d]) => d.key === key).map(([id]) => id);
        for (const id of stale) { await deleteDoc(id); delete reg.docs[id]; }
        let stored = 0;
        for (let i = 0; i < chunks.length; i++) {
            const text = String(chunks[i] ?? '').trim();
            if (!text) continue;
            const docId = docIdFor(key, i);
            await uploadDoc(docId, `${header(key, i)}\n${text}`);
            reg.docs[docId] = { key, chunk: i };
            stored++;
        }
        writeRegistry(reg);
        res.json({ message: 'Stored successfully', key, stored });
    } catch (err) {
        console.error('[recall/store]', key, err.message);
        res.status(502).json({ error: `store failed: ${err.message}` });
    }
});

// Semantic search. Body: {query, keys: [string]|[], topN}. Returns
// [{key, chunk, text, relevanceScore}] — already ranked, ready for the caller.
app.post('/search', async (req, res) => {
    const { query, keys = [], topN = 5 } = req.body || {};
    if (!query) return res.status(400).json({ error: 'expected {query}' });
    try {
        await ensureCollection();
        // Over-fetch so post-filtering by key still fills topN.
        const k = Math.min(Math.max(topN * 3, topN + 4), 20);
        const results = await searchDocs(query, k);
        const wanted = new Set(keys);
        const out = [];
        for (const r of results) {
            const { key, chunk, text } = parseHeader(r.Content ?? r.content ?? '');
            if (key === null) continue;
            if (wanted.size && !wanted.has(key)) continue;
            out.push({ key, chunk, text, relevanceScore: r.Similarity ?? r.similarity ?? 0 });
            if (out.length >= topN) break;
        }
        res.json(out);
    } catch (err) {
        console.error('[recall/search]', err.message);
        res.status(502).json({ error: `search failed: ${err.message}` });
    }
});

// Delete every chunk of a key. (GET + DELETE — the frontend eraser sends DELETE.)
const handleDelete = async (req, res) => {
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: 'expected ?key=' });
    try {
        const reg = readRegistry();
        const ids = Object.entries(reg.docs).filter(([, d]) => d.key === key).map(([id]) => id);
        let deleted = 0;
        for (const id of ids) {
            if (await deleteDoc(id)) deleted++;
            delete reg.docs[id];
        }
        writeRegistry(reg);
        res.json({ message: 'Deleted', key, deleted });
    } catch (err) {
        console.error('[recall/delete]', key, err.message);
        res.status(502).json({ error: `delete failed: ${err.message}` });
    }
};
app.get('/delete', handleDelete);
app.delete('/delete', handleDelete);

export default app;
